import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { sharedRuntimeCapabilities } from "../../src/runtime-capabilities.mjs";
import { keepThreadMeta } from "./test-home.js";
import { auditDir,gate,startStreamingFixture,stop } from "./native-stream-fixture.js";
const SHOTS=process.env.TREBELL_PROOF_SHOTS?String(process.env.TREBELL_PROOF_SHOTS).replace(/[\\/]*$/,"/"):auditDir+"proof-";
if(process.env.TREBELL_PROOF_SHOTS)mkdirSync(SHOTS,{recursive:true});

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
  else{await page.getByRole("button",{name:/More actions/}).first().click();await page.getByTestId("header-overflow-menu").getByRole("button",{name:/^Switch to (light|dark) mode$/}).click()}
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
      const nativeDialogs=[];page.on("dialog",dialog=>{nativeDialogs.push(dialog.type()+": "+dialog.message());dialog.dismiss().catch(()=>{})});
      await row.getByRole("button",{name:action,exact:true}).click();
      // Delete asks first, in the app's own dialog; Archive does not ask.
      if(action==="Delete"){
        const question=page.locator("dialog.inspector-text-prompt");
        await expect(question.locator("p")).toHaveText("Delete “Fix login redirect” permanently? This cannot be undone.");
        await question.getByRole("button",{name:"Delete thread",exact:true}).click();await expect(question).toHaveCount(0);
      }
      await expect(threadRow(page,"Fix login redirect")).toHaveCount(0);expect(nativeDialogs).toEqual([]);
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
// (turn/started) and lets the answer go, in either order, as Codex sends them; an answer before the turn started names it queued
// (startedAt null). A started turn streams its reply and completes unless turn/interrupt ends it first, and as codex-cli 0.162
// does, an interrupt for a turn not started yet is refused ("no active turn to interrupt"). interruptDelayMs holds the interrupt's
// answer (Codex answers once the turn has stopped), interruptError refuses every interrupt with that message, the turn going on,
// compactError fails thread/compact/start with that message, holdTurns keeps a turn running after its reply until it is set
// false, steerHold, a gate, holds turn/steer's answer until it opens, and drainQueue has Codex start the first follow-up of its
// queue as a turn completes, as Codex does. project makes the thread a project thread, whose follow-ups wait in Trebell's own
// queue (Codex's queue, codex.queue, holds only General chats'); settings adds to the app's settings.
// names: several threads, the first opened. Each turn is its thread's; turn.fail refuses its turn/start, and a thread with a started
// turn still running resumes active, with its turns. modes: the collaboration modes Codex lists. capabilities: the runtime's
// capabilities, when they are not Codex's own. catalog: the app's state lists the threads' meta as the server does, as a catalog
// whose full entries (the follow-ups queued among them) a thread reads as it opens, so a reload finds what the window saved.
// codex.calls: the methods the app asked for, in order; codex.sent(method): the params of each request for that method.
async function startCodex(page,{name,names=[name],project=false,settings={},modes=[],capabilities=null,catalog=false}){
  const cwd=project?await mkdtemp(join(tmpdir(),"turn-controls-codex-")):process.cwd(),now=Date.now()/1000;
  const threads=names.map((threadName,index)=>({id:"codex-stop-thread"+(index?"-"+(index+1):""),name:threadName,preview:threadName,cwd,createdAt:now-60+index,updatedAt:now-index,status:{type:"idle"},turns:[]})),[thread]=threads;
  const codex={thread,threads,turns:[],interrupts:[],interruptDelayMs:0,holdTurns:false,socket:null,queue:[],calls:[],requests:[]};
  codex.sent=method=>codex.requests.filter(message=>message.method===method).map(message=>message.params||{});
  const live=item=>{const turns=codex.turns.filter(turn=>turn.threadId===item.id&&turn.status!=="refused");return {...item,status:turns.some(turn=>turn.started&&turn.status==="inProgress")?{type:"active",activeFlags:[]}:{type:"idle"},turns:turns.map(turn=>({id:turn.id,status:turn.status,items:[]}))}};
  const upstream=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set();
  upstream.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  const notify=(method,params)=>{if(codex.socket?.readyState===1)codex.socket.send(JSON.stringify({method,params}))};
  const end=(turn,status)=>{turn.status=status;clearTimeout(turn.timer);notify("turn/completed",{threadId:turn.threadId,turn:{id:turn.id,status,items:[]}});if(status==="completed"&&codex.drainQueue)startQueued(turn.threadId)};
  // A turn Codex starts streams its reply and completes, unless it has ended already. ask: the message of a follow-up its queue
  // starts, which Codex sends as the turn's first item.
  const run=(turn,ask=null)=>{
    turn.started=true;notify("turn/started",{threadId:turn.threadId,turn:{id:turn.id,status:"inProgress",items:[]}});
    if(ask)notify("item/completed",{threadId:turn.threadId,turnId:turn.id,item:ask});
    if(turn.status!=="inProgress")return end(turn,turn.status);
    const itemId="reply-"+turn.id,words="One two three four five six seven eight nine ten. Counting is done.".split(/(?<= )/);let index=0;
    notify("item/started",{threadId:turn.threadId,turnId:turn.id,item:{type:"agentMessage",id:itemId,text:""}});
    const tick=()=>{
      if(turn.status!=="inProgress")return;
      if(index<words.length){notify("item/agentMessage/delta",{threadId:turn.threadId,turnId:turn.id,itemId,delta:words[index++]});turn.timer=setTimeout(tick,60);return}
      if(codex.holdTurns){turn.timer=setTimeout(tick,60);return}
      notify("item/completed",{threadId:turn.threadId,turnId:turn.id,item:{type:"agentMessage",id:itemId,text:words.join("")}});end(turn,"completed");
    };
    turn.timer=setTimeout(tick,60);
  };
  // drainQueue: the thread's first follow-up leaves Codex's queue and runs as a turn of its own.
  const startQueued=threadId=>{
    const item=codex.queue.find(entry=>entry.threadId===threadId);if(!item)return;
    codex.queue=codex.queue.filter(entry=>entry!==item);notify("thread/queue/changed",{threadId});
    const turn={id:"codex-turn-"+(codex.turns.length+1),threadId,status:"inProgress",started:false,timer:null};codex.turns.push(turn);
    run(turn,{id:"ask-"+turn.id,type:"userMessage",clientId:item.clientUserMessageId,content:item.input});
  };
  // Codex closes a thread's session once no window follows it, and says so.
  codex.closeThread=threadId=>notify("thread/closed",{threadId});
  // Any other notification, as Codex sends it.
  codex.notify=notify;
  wss.on("connection",ws=>{
    sockets.add(ws);codex.socket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;codex.calls.push(message.method);codex.requests.push(message);
      const params=message.params||{},respond=result=>{if(ws.readyState===1)ws.send(JSON.stringify({id:message.id,result}))};
      if(message.method==="turn/start"){
        const turn={id:"codex-turn-"+(codex.turns.length+1),threadId:params.threadId||thread.id,status:"inProgress",started:false,timer:null};codex.turns.push(turn);
        turn.answer=()=>respond({turn:{id:turn.id,status:"inProgress",items:[],startedAt:turn.started?Math.floor(Date.now()/1000):null}});
        turn.fail=text=>{turn.status="refused";if(ws.readyState===1)ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:text}}))};
        turn.start=()=>run(turn);
        return;
      }
      if(message.method==="thread/compact/start"&&codex.compactError){ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:codex.compactError}}));return}
      if(message.method==="turn/steer"&&codex.steerHold){codex.steerHold.promise.then(()=>respond({}));return}
      if(message.method==="turn/interrupt"){
        codex.interrupts.push({...params});const turn=codex.turns.find(item=>item.id===params.turnId);
        if(codex.interruptError){ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:codex.interruptError}}));return}
        if(turn&&!turn.started){ws.send(JSON.stringify({id:message.id,error:{code:-32600,message:"no active turn to interrupt"}}));return}
        setTimeout(()=>{if(turn?.status==="inProgress")end(turn,"interrupted");respond({})},codex.interruptDelayMs);return;
      }
      // Codex's own queue, a General chat's follow-ups: each change is told with thread/queue/changed.
      if(message.method==="thread/queue/add"){
        const item={id:"queued-"+codex.calls.length,threadId:params.threadId,input:params.input,clientUserMessageId:params.clientUserMessageId};codex.queue.push(item);
        respond({queuedSubmission:item});notify("thread/queue/changed",{threadId:params.threadId});return;
      }
      if(message.method==="thread/queue/delete"){
        const before=codex.queue.length;codex.queue=codex.queue.filter(item=>item.id!==params.queuedSubmissionId);
        respond({deleted:codex.queue.length<before});notify("thread/queue/changed",{threadId:params.threadId});return;
      }
      let result={};
      if(message.method==="initialize")result={userAgent:"turn-controls-codex"};
      else if(message.method==="thread/list")result={data:threads.map(live),nextCursor:null};
      else if(message.method==="thread/resume")result={thread:live(threads.find(item=>item.id===params.threadId)||thread),itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/queue/list")result={data:codex.queue.filter(item=>item.threadId===params.threadId),nextCursor:null};
      else if(["thread/turns/list","thread/items/list","thread/attachment/list","thread/timeline/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(message.method==="collaborationMode/list")result={data:modes};
      else if(["threadSection/list","skills/list"].includes(message.method))result={data:[]};
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
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:process.platform,version:"turn-controls-codex",activeEnvironmentId:null,activeEnvironment:null,...(capabilities?{runtimeCapabilities:capabilities}:{})}));
  const projects=project?[{id:"codex-queue-project",name:"Codex queue project",path:cwd,environmentId:null,effectiveSettings:{}}]:[];
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue",...settings},projects,...(project?{activeProjectId:projects[0].id}:{}),threadMeta:Object.fromEntries(threads.map(item=>[item.id,{...(project?{projectless:false,environmentId:null,cwd}:{projectless:true,environmentId:null}),...(catalog?{__catalogOnly:true}:{})}]))}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{project:projects[0]||null}:{projects}));
  if(project){
    await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:false,root:cwd,branch:null,status:[],remotes:[],worktrees:[]}));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{id:"codex-queue-checkpoint",threadId:thread.id}:{checkpoints:[]}));
    await page.route(/\/api\/checkpoints\/link$/,route=>json(route,{ok:true}));
    await page.route(/\/api\/context\/packet$/,route=>json(route,{id:"codex-queue-context",skipped:true,budget:{reserveTokens:1024}}));
  }
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.goto("/");
  await threadRow(page,names[0]).locator(".thread-main").click();await expect(composer(page)).toBeEnabled({timeout:15_000});
  codex.close=async()=>{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}wss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstream.close(resolve))]);if(project)await rm(cwd,{recursive:true,force:true,maxRetries:8,retryDelay:100})};
  return codex;
}
const stopping=page=>page.getByRole("button",{name:"Stopping",exact:true});

// Codex names a send's turn in turn/start's answer or in turn/started, whichever it sends first, and can interrupt it only once it has
// started it: an answer that comes first names the turn queued (startedAt null). A Stop pressed before then is kept: the header says
// Stopping while the turn runs, the interrupt goes to the turn as soon as Codex has started it, and only once, and the stopped turn
// ends stopped, without its reply.
for(const first of ["turn/started","the turn/start answer"]){
  test(`Stop before Codex names the turn goes to it once Codex has started it, ${first} first, and the turn shows stopping until it ends`,async({page})=>{
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
      // The answer names the turn queued: nothing goes to it until Codex has started it.
      if(first!=="turn/started"){turn.answer();await page.waitForTimeout(400);expect(codex.interrupts).toEqual([]);await expect(stopping(page)).toBeVisible()}
      turn.start();
      await expect.poll(()=>codex.interrupts).toEqual([{threadId:codex.thread.id,turnId:turn.id}]);
      if(first==="turn/started"){await page.waitForTimeout(200);turn.answer()}
      await expect(stop(page)).toHaveCount(0,{timeout:10_000});await expect(stopping(page)).toHaveCount(0);
      await expect(page.getByTestId("turn-outcome").last()).toHaveText(/^stopped/);
      await page.waitForTimeout(500);
      expect(codex.interrupts).toHaveLength(1);
      await expect(page.getByText("Counting is done.",{exact:false})).toHaveCount(0);
      await expect(composer(page)).toHaveAttribute("placeholder",IDLE_PLACEHOLDER);
    }finally{await codex.close()}
  });
}

// The case live Codex showed: its answer came at once and named the turn queued, and Stop, pressed before turn/started, sent an
// interrupt Codex refused ("no active turn to interrupt"), so the turn ran to its end. The Stop now waits for turn/started.
test("Stop on a turn Codex has queued but not started waits for turn/started, and the turn ends stopped",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{name:"Codex queued turn"});
  try{
    await sendTyped(page,"Count from one to forty, one number per line.");
    await expect.poll(()=>codex.turns.length).toBe(1);const [turn]=codex.turns;
    turn.answer();await expect(composer(page)).toHaveAttribute("placeholder","Queue a follow-up…");
    await stop(page).click();
    await expect(stopping(page)).toBeVisible();await page.waitForTimeout(400);
    expect(codex.interrupts).toEqual([]);await expect(stopping(page)).toBeVisible();
    await shoot(page,"stopping-queued-turn");
    turn.start();
    await expect.poll(()=>codex.interrupts).toEqual([{threadId:codex.thread.id,turnId:turn.id}]);
    await expect(stopping(page)).toHaveCount(0,{timeout:10_000});await expect(stop(page)).toHaveCount(0);
    await expect(page.getByTestId("turn-outcome").last()).toHaveText(/^stopped/);
    await page.waitForTimeout(500);
    expect(codex.interrupts).toHaveLength(1);await expect(page.getByText("Counting is done.",{exact:false})).toHaveCount(0);
    await expect(page.getByTestId("app-action-error")).toHaveCount(0);
  }finally{await codex.close()}
});

// That send counts as running only while Codex runs the thread: when its turn/started and turn/completed never reach the window (a
// reconnect drops them), the thread opens again idle, not running with a Stop that waits for nothing.
test("a thread whose queued turn Codex no longer runs opens again idle",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{name:"Codex lost start"});
  try{
    await sendTyped(page,"Count from one to forty, one number per line.");
    await expect.poll(()=>codex.turns.length).toBe(1);const [turn]=codex.turns;
    turn.answer();await expect(composer(page)).toHaveAttribute("placeholder","Queue a follow-up…");
    // Codex runs the turn to its end, and neither notification reaches the window.
    turn.started=true;turn.status="completed";
    await newTask(page).click();await expectIdleNewTask(page);
    await threadRow(page,"Codex lost start").locator(".thread-main").click();
    await expect(composer(page)).toHaveAttribute("placeholder",IDLE_PLACEHOLDER,{timeout:10_000});
    await expect(stop(page)).toHaveCount(0);await expect(stopping(page)).toHaveCount(0);
  }finally{await codex.close()}
});

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

// The Stop shortcut, pressed before Codex names the turn and again once it has, while the interrupt sent on its naming is still on
// its way, sends that one interrupt and no other.
test("the Stop shortcut pressed before and after Codex names the turn sends one turn/interrupt for it",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{name:"Codex stop shortcut",settings:{keybindingRules:[{command:"threadStop",key:"Ctrl+Alt+X"}]}});
  try{
    codex.interruptDelayMs=800;
    await sendTyped(page,"Count from one to forty, one number per line.");
    await expect.poll(()=>codex.turns.length).toBe(1);const [turn]=codex.turns;
    await page.keyboard.press("Control+Alt+X");await expect(stopping(page)).toBeVisible();
    turn.start();await expect.poll(()=>codex.interrupts.length).toBe(1);
    turn.answer();await expect(composer(page)).not.toHaveAttribute("placeholder","Sending…");await expect(stopping(page)).toBeVisible();
    await page.keyboard.press("Control+Alt+X");
    await expect(stopping(page)).toHaveCount(0,{timeout:10_000});await expect(stop(page)).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(codex.interrupts).toEqual([{threadId:codex.thread.id,turnId:turn.id}]);
    await expect(page.getByTestId("turn-outcome").last()).toHaveText(/^stopped/);
  }finally{await codex.close()}
});

// Stop stops the turn and nothing more: the follow-ups queued behind it stay queued as they were, none of them starts, and the
// composer keeps only the draft typed there, in Trebell's own queue (a project thread's) as in Codex's (a General chat's). Codex
// sends the stopped turn's turn/completed before it answers the interrupt. Trebell's queue goes on once the thread runs a turn
// again: the draft, sent, runs first, and the first follow-up starts when it ends. A Stop while that follow-up is on its way, before
// its turn exists, leaves it queued as it was too, with a follow-up queued meanwhile: away and back it reads held as the others do,
// not as a send to retry, and it starts with the queue when the next turn ends.
for(const kind of ["Trebell","Codex"]){
  test(`Stop with follow-ups in ${kind}'s queue starts none of them and leaves them queued, and the composer keeps only the draft`,async({page})=>{
    test.setTimeout(90_000);
    await page.setViewportSize({width:1280,height:800});
    const codex=await startCodex(page,{name:"Stop with a queue",project:kind==="Trebell"});
    try{
      codex.holdTurns=true;
      await sendTyped(page,"Main task with a queue.");await expect.poll(()=>codex.turns.length).toBe(1);codex.turns[0].answer();codex.turns[0].start();
      await expect(stop(page)).toBeVisible();
      for(const text of ["Queued alpha","Queued beta"]){await sendTyped(page,text);await expect(page.locator(".queued-message").filter({hasText:text})).toHaveCount(1)}
      await typeInComposer(page,"My unsent draft");
      await stop(page).click();
      await expect(page.getByTestId("turn-outcome").last()).toHaveText(/^stopped/,{timeout:10_000});
      await page.waitForTimeout(800);
      // No turn started after the stopped one, and nothing was started from Codex's queue.
      expect(codex.turns.map(turn=>turn.id)).toEqual(["codex-turn-1"]);expect(codex.calls).not.toContain("thread/queue/start");
      await expect(page.locator(".queued-message p")).toHaveText(["Queued alpha","Queued beta"]);
      await expect(composer(page)).toHaveValue("My unsent draft");
      await expect(stop(page)).toHaveCount(0);await expect(stopping(page)).toHaveCount(0);
      await shoot(page,"stop-with-a-"+kind.toLowerCase()+"-queue");
      if(kind==="Trebell"){
        // The first follow-up's send waits on its repository context, so the Stop comes before its turn exists.
        let context=null;await page.route(/\/api\/context\/packet$/,async route=>{await context?.promise;await route.fallback()});
        codex.holdTurns=false;
        await composer(page).click();await page.keyboard.press("Enter");
        await expect.poll(()=>codex.turns.length).toBe(2);context=gate();codex.turns[1].answer();codex.turns[1].start();
        await expect(page.locator(".user-bubble").filter({hasText:"My unsent draft"})).toBeVisible();
        const alphaSent=page.locator(".user-bubble").filter({hasText:"Queued alpha"});
        await expect(alphaSent).toBeVisible({timeout:10_000});
        // A follow-up queued while the first one is on its way stays queued with the others.
        await sendTyped(page,"Queued gamma");await expect(page.locator(".queued-message").filter({hasText:"Queued gamma"})).toHaveCount(1);
        await stop(page).click();context.open();
        await expect(alphaSent).toHaveCount(0);await expect(stop(page)).toHaveCount(0);await expect(stopping(page)).toHaveCount(0);
        await page.waitForTimeout(800);
        expect(codex.turns).toHaveLength(2);
        await expect(page.locator(".queued-message p")).toHaveText(["Queued alpha","Queued beta","Queued gamma"]);await expect(composer(page)).toHaveValue("");
        // Away and back, the follow-up whose send the Stop ended reads held with the others, not as a send that may have started.
        const labels=page.locator(".queued-message>span");
        await newTask(page).click();await expectIdleNewTask(page);
        await threadRow(page,"Stop with a queue").locator(".thread-main").click();
        await expect(page.locator(".queued-message p")).toHaveText(["Queued alpha","Queued beta","Queued gamma"],{timeout:10_000});
        await expect(labels).toHaveText(Array(3).fill("Queued · held after Stop"));
        // A message sent runs the thread again, and the queue goes on when its turn ends, that follow-up first.
        await sendTyped(page,"One more task.");
        await expect.poll(()=>codex.turns.length).toBe(3);codex.turns[2].answer();codex.turns[2].start();
        await expect.poll(()=>codex.turns.length,{timeout:15_000}).toBe(4);codex.holdTurns=true;codex.turns[3].answer();codex.turns[3].start();
        await expect(alphaSent).toBeVisible();await expect(page.locator(".queued-message p")).toHaveText(["Queued beta","Queued gamma"]);
        await expect(labels).toHaveText(["Queued","Queued"]);
        // Stopped again, the queue waits for the person and says so; the shortcut that sends the oldest follow-up now sends it then, as
        // Send now does, and the rest of the queue goes on after it.
        await stop(page).click();
        await expect(stop(page)).toHaveCount(0,{timeout:10_000});await expect(stopping(page)).toHaveCount(0);
        await expect(labels).toHaveText(["Queued · held after Stop","Queued · held after Stop"]);
        await page.waitForTimeout(800);expect(codex.turns).toHaveLength(4);
        await composer(page).click();await page.keyboard.press("Control+Shift+Enter");
        await expect.poll(()=>codex.turns.length).toBe(5);codex.turns[4].answer();codex.turns[4].start();
        await expect(page.locator(".user-bubble").filter({hasText:"Queued beta"})).toBeVisible();
        await expect(page.locator(".queued-message p")).toHaveText(["Queued gamma"]);await expect(labels).toHaveText(["Queued"]);
        await expect(composer(page)).toHaveValue("");
      }
    }finally{await codex.close()}
  });
}

// The hold a Stop puts on Trebell's queue stays with the thread's queue: after the window reloads, as after Trebell starts again,
// the follow-ups still read held and none starts by itself, as when the thread is left and opened again. The hold ends as before:
// a follow-up sent now runs the thread again, and the next starts by itself once that turn ends, also after another reload.
test("follow-ups a Stop held stay held after the window reloads, and the queue goes on once one is sent now",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{name:"Held queue",project:true,catalog:true});
  const queue=page.locator(".queued-message p"),labels=page.locator(".queued-message>span"),row=threadRow(page,"Held queue");
  const reload=async()=>{await page.reload();await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);await expect(composer(page)).toBeEnabled({timeout:15_000})};
  try{
    codex.holdTurns=true;
    await sendTyped(page,"Main task with a queue.");await expect.poll(()=>codex.turns.length).toBe(1);codex.turns[0].answer();codex.turns[0].start();
    await expect(stop(page)).toBeVisible();
    for(const text of ["Queued alpha","Queued beta"]){await sendTyped(page,text);await expect(page.locator(".queued-message").filter({hasText:text})).toHaveCount(1)}
    await stop(page).click();
    await expect(page.getByTestId("turn-outcome").last()).toHaveText(/^stopped/,{timeout:10_000});
    await expect(labels).toHaveText(Array(2).fill("Queued · held after Stop"));
    await reload();
    await expect(queue).toHaveText(["Queued alpha","Queued beta"],{timeout:10_000});
    await page.waitForTimeout(800);
    expect(codex.turns.map(turn=>turn.id),"no turn started by itself after the reload").toEqual(["codex-turn-1"]);
    await expect(labels,"the follow-ups a Stop held, the window reloaded").toHaveText(Array(2).fill("Queued · held after Stop"));
    await expect(stop(page)).toHaveCount(0);
    await shoot(page,"held-queue-after-reload");
    // Sent now, alpha runs the thread again: the hold ends, and beta reads queued, after another reload too.
    await page.locator(".queued-message").filter({hasText:"Queued alpha"}).getByRole("button",{name:"Send now"}).click();
    await expect.poll(()=>codex.turns.length).toBe(2);codex.turns[1].answer();codex.turns[1].start();
    await expect(page.locator(".user-bubble").filter({hasText:"Queued alpha"})).toBeVisible();
    await expect(queue).toHaveText(["Queued beta"]);await expect(labels).toHaveText(["Queued"]);
    await reload();
    await expect(queue).toHaveText(["Queued beta"],{timeout:10_000});await expect(labels).toHaveText(["Queued"]);
    // beta starts by itself once alpha's turn ends.
    codex.holdTurns=false;
    await expect.poll(()=>codex.turns.length,{timeout:15_000}).toBe(3);codex.turns[2].answer();codex.turns[2].start();
    await expect(page.locator(".user-bubble").filter({hasText:"Queued beta"})).toBeVisible();await expect(page.locator(".queued-message")).toHaveCount(0);
  }finally{await codex.close()}
});

// A Stop that fails holds nothing: the turn goes on, its follow-ups in Trebell's queue read queued as before, and the first starts by
// itself when the turn ends. Codex refuses the interrupt for a turn it runs (stop()), or for the turn it had queued once it starts it
// (the Stop waited for turn/started).
for(const when of ["a turn Codex runs","a turn Codex has queued"]){
  test(`a Stop that fails for ${when} leaves Trebell's queue to start by itself when the turn ends`,async({page})=>{
    test.setTimeout(60_000);
    await page.setViewportSize({width:1280,height:800});
    const codex=await startCodex(page,{name:"Stop that fails",project:true});
    try{
      codex.holdTurns=true;codex.interruptError="Deliberate interrupt failure";
      await sendTyped(page,"Main task with a queue.");await expect.poll(()=>codex.turns.length).toBe(1);const [turn]=codex.turns;
      turn.answer();if(when==="a turn Codex runs")turn.start();
      await expect(composer(page)).toHaveAttribute("placeholder","Queue a follow-up…");
      for(const text of ["Queued alpha","Queued beta"]){await sendTyped(page,text);await expect(page.locator(".queued-message").filter({hasText:text})).toHaveCount(1)}
      const labels=page.locator(".queued-message>span");
      await stop(page).click();
      if(when==="a turn Codex has queued"){await expect(stopping(page)).toBeVisible();expect(codex.interrupts).toEqual([]);turn.start()}
      await expect(page.getByTestId("app-action-error")).toHaveText("Could not stop turn: Deliberate interrupt failure");
      expect(codex.interrupts).toEqual([{threadId:codex.thread.id,turnId:turn.id}]);
      // The turn runs on with its Stop, and the follow-ups wait for it as before the Stop.
      await expect(stop(page)).toBeVisible();await expect(stopping(page)).toHaveCount(0);
      await expect(labels).toHaveText(["Queued","Queued"]);
      await shoot(page,"stop-failed-"+(when==="a turn Codex runs"?"running":"queued")+"-turn");
      codex.holdTurns=false;
      await expect.poll(()=>codex.turns.length,{timeout:15_000}).toBe(2);codex.holdTurns=true;codex.turns[1].answer();codex.turns[1].start();
      await expect(page.locator(".user-bubble").filter({hasText:"Queued alpha"})).toBeVisible();
      await expect(page.locator(".queued-message p")).toHaveText(["Queued beta"]);await expect(labels).toHaveText(["Queued"]);
      expect(codex.interrupts).toHaveLength(1);
    }finally{await codex.close()}
  });
}

// A follow-up queued while the one before it is on its way, before that one's turn exists, stays queued behind it when that send
// ends, whether Codex starts its turn or refuses it, as the queue starts it and as Send now or its shortcut sends it: the send
// writes back only its own follow-up, into the queue as it is by then. A turn that starts takes out only the follow-up it sent,
// and the next starts by itself when that turn ends; a start that fails marks only its follow-up to retry, and the queue goes on
// once Send now has sent it. A follow-up Send now steers into the running turn leaves the queue the same way.
for(const outcome of ["starts","fails"]){
  test(`a follow-up queued while the one before it is on its way stays queued when that one's turn ${outcome==="starts"?"starts":"fails to start"}`,async({page})=>{
    test.setTimeout(90_000);
    await page.setViewportSize({width:1280,height:800});
    const codex=await startCodex(page,{name:"Queue on its way",project:true});
    const queue=page.locator(".queued-message p"),labels=page.locator(".queued-message>span"),sent=text=>page.locator(".user-bubble").filter({hasText:text});
    const sendNow=text=>page.locator(".queued-message").filter({hasText:text}).getByRole("button",{name:"Send now"});
    try{
      // A follow-up's send waits on its repository context while context is a gate not yet open.
      let context=null;await page.route(/\/api\/context\/packet$/,async route=>{await context?.promise;await route.fallback()});
      codex.holdTurns=true;
      await sendTyped(page,"Main task with a queue.");await expect.poll(()=>codex.turns.length).toBe(1);codex.turns[0].answer();codex.turns[0].start();
      await expect(stop(page)).toBeVisible();
      await sendTyped(page,"Queued alpha");await expect(queue).toHaveText(["Queued alpha"]);
      // The turn ends and the queue starts alpha, whose send waits on its context while beta is queued.
      context=gate();codex.holdTurns=false;
      await expect(sent("Queued alpha")).toBeVisible({timeout:10_000});codex.holdTurns=true;
      await sendTyped(page,"Queued beta");await expect(queue).toHaveText(["Queued alpha","Queued beta"]);
      context.open();await expect.poll(()=>codex.turns.length).toBe(2);
      if(outcome==="starts"){
        codex.turns[1].answer();codex.turns[1].start();
        // alpha's turn runs, and beta waits behind it.
        await expect(sent("Queued alpha")).toBeVisible();await expect(queue).toHaveText(["Queued beta"]);await expect(labels).toHaveText(["Queued"]);
        await shoot(page,"queued-while-on-its-way-turn-starts");
        // Send now steers beta into alpha's turn; gamma, queued while that is on its way, stays.
        codex.steerHold=gate();await sendNow("Queued beta").click();
        await expect.poll(()=>codex.calls.filter(method=>method==="turn/steer").length).toBe(1);
        await sendTyped(page,"Queued gamma");await expect(queue).toHaveText(["Queued beta","Queued gamma"]);
        codex.steerHold.open();
        await expect(sent("Queued beta")).toBeVisible();await expect(queue).toHaveText(["Queued gamma"]);
        // Stopped, the queue waits; the shortcut sends gamma, whose send waits on its context while delta is queued.
        await stop(page).click();
        await expect(stop(page)).toHaveCount(0,{timeout:10_000});await expect(labels).toHaveText(["Queued · held after Stop"]);
        context=gate();await composer(page).click();await page.keyboard.press("Control+Shift+Enter");
        await expect(sent("Queued gamma")).toBeVisible();
        await sendTyped(page,"Queued delta");await expect(queue).toHaveText(["Queued gamma","Queued delta"]);
        context.open();await expect.poll(()=>codex.turns.length).toBe(3);codex.turns[2].answer();codex.turns[2].start();
        await expect(queue).toHaveText(["Queued delta"]);await expect(labels).toHaveText(["Queued"]);
        // delta starts by itself once gamma's turn ends.
        codex.holdTurns=false;
        await expect.poll(()=>codex.turns.length,{timeout:15_000}).toBe(4);codex.turns[3].answer();codex.turns[3].start();
        await expect(sent("Queued delta")).toBeVisible();await expect(page.locator(".queued-message")).toHaveCount(0);
        await expect(stop(page)).toHaveCount(0,{timeout:10_000});
      }else{
        codex.turns[1].fail("Deliberate queued start failure");
        // Only alpha is marked to retry, and beta waits behind it.
        await expect(page.getByTestId("composer-alert")).toHaveText("Queued follow-up not sent: Deliberate queued start failure.");
        await expect(queue).toHaveText(["Queued alpha","Queued beta"]);await expect(labels).toHaveText(["Queued · retry needed","Queued"]);
        await expect(sent("Queued alpha")).toHaveCount(0);
        await shoot(page,"queued-while-on-its-way-start-fails");
        // Send now sends alpha again, whose send waits on its context while gamma is queued, and Codex refuses it again.
        context=gate();await sendNow("Queued alpha").click();
        await expect(sent("Queued alpha")).toBeVisible();
        await sendTyped(page,"Queued gamma");await expect(queue).toHaveText(["Queued alpha","Queued beta","Queued gamma"]);
        context.open();await expect.poll(()=>codex.turns.length).toBe(3);codex.turns[2].fail("Deliberate queued start failure");
        await expect(page.getByTestId("app-action-error")).toHaveText("Could not send queued follow-up: Deliberate queued start failure");
        await expect(queue).toHaveText(["Queued alpha","Queued beta","Queued gamma"]);await expect(labels).toHaveText(["Queued · retry needed","Queued","Queued"]);
        // Nothing starts it again by itself.
        await page.waitForTimeout(800);expect(codex.turns).toHaveLength(3);
        // Sent now once more, it runs, and beta and gamma start by themselves after it.
        await sendNow("Queued alpha").click();
        await expect.poll(()=>codex.turns.length).toBe(4);codex.turns[3].answer();codex.turns[3].start();
        await expect(sent("Queued alpha")).toBeVisible();await expect(queue).toHaveText(["Queued beta","Queued gamma"]);await expect(labels).toHaveText(["Queued","Queued"]);
        codex.holdTurns=false;
        await expect.poll(()=>codex.turns.length,{timeout:15_000}).toBe(5);codex.turns[4].answer();codex.turns[4].start();
        await expect(sent("Queued beta")).toBeVisible();await expect(queue).toHaveText(["Queued gamma"]);
        await expect.poll(()=>codex.turns.length,{timeout:15_000}).toBe(6);codex.turns[5].answer();codex.turns[5].start();
        await expect(sent("Queued gamma")).toBeVisible();await expect(page.locator(".queued-message")).toHaveCount(0);
        await expect(stop(page)).toHaveCount(0,{timeout:10_000});
      }
    }finally{await codex.close()}
  });
}

// A follow-up on its way, a turn the queue or Send now starts for it or a steer of it into the turn that runs, goes whatever its
// card's buttons are pressed for: its card says it is being sent, never queued beside its sent message, and its Send now, Edit and
// Remove are off, so a press neither drops a follow-up that is sent anyway nor sends it twice. Its thread left and opened again
// meanwhile, it still reads so. Once it has gone it leaves the queue; a start that fails brings it back queued, to retry, with its
// buttons on.
test("a follow-up on its way says it is being sent, with Send now, Edit and Remove off, until it has gone or its start fails",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{name:"Follow-up on its way",project:true});
  const queue=page.locator(".queued-message p"),labels=page.locator(".queued-message>span"),sent=text=>page.locator(".user-bubble").filter({hasText:text});
  const button=(text,name)=>page.locator(".queued-message").filter({hasText:text}).getByRole("button",{name,exact:true});
  try{
    // A follow-up's send waits on its repository context while context is a gate not yet open.
    let context=null;await page.route(/\/api\/context\/packet$/,async route=>{await context?.promise;await route.fallback()});
    codex.holdTurns=true;
    await sendTyped(page,"Main task with a queue.");await expect.poll(()=>codex.turns.length).toBe(1);codex.turns[0].answer();codex.turns[0].start();
    await expect(stop(page)).toBeVisible();
    for(const text of ["Queued alpha","Queued beta","Queued gamma"]){await sendTyped(page,text);await expect(page.locator(".queued-message").filter({hasText:text})).toHaveCount(1)}
    // The turn ends and the queue starts alpha, whose send waits on its context.
    context=gate();codex.holdTurns=false;
    await expect(sent("Queued alpha")).toBeVisible({timeout:10_000});codex.holdTurns=true;
    await expect(labels,"alpha's card, its message sent").toHaveText(["Sending…","Queued","Queued"]);
    for(const name of ["Send now","Edit","Remove"])await expect(button("Queued alpha",name)).toBeDisabled();
    await expect(button("Queued alpha","Remove")).toHaveAttribute("title","This follow-up is already being sent");
    await expect(button("Queued beta","Remove")).toBeEnabled();
    await shoot(page,"queued-follow-up-on-its-way");
    // Pressed anyway, Remove and Edit leave it as it is, and so does the shortcut that sends the oldest follow-up now.
    await button("Queued alpha","Remove").click({force:true});await button("Queued alpha","Edit").click({force:true});
    await composer(page).click();await page.keyboard.press("Control+Shift+Enter");
    await page.waitForTimeout(400);
    await expect(queue).toHaveText(["Queued alpha","Queued beta","Queued gamma"]);await expect(labels).toHaveText(["Sending…","Queued","Queued"]);
    await expect(composer(page)).toHaveValue("");
    // Away and back, it still reads as being sent, not as a send to retry.
    await newTask(page).click();await expectIdleNewTask(page);
    await threadRow(page,"Follow-up on its way").locator(".thread-main").click();
    await expect(sent("Queued alpha")).toBeVisible({timeout:10_000});
    await expect(queue).toHaveText(["Queued alpha","Queued beta","Queued gamma"]);
    await expect(labels,"alpha's card, its thread opened again").toHaveText(["Sending…","Queued","Queued"]);
    for(const name of ["Edit","Remove"])await expect(button("Queued alpha",name)).toBeDisabled();
    // Its turn starts: it leaves the queue, sent once.
    context.open();await expect.poll(()=>codex.turns.length).toBe(2);codex.turns[1].answer();codex.turns[1].start();
    await expect(queue).toHaveText(["Queued beta","Queued gamma"]);await expect(labels).toHaveText(["Queued","Queued"]);await expect(sent("Queued alpha")).toHaveCount(1);
    // Sent now, beta is steered into alpha's turn, and is on its way until Codex has it.
    codex.steerHold=gate();await button("Queued beta","Send now").click();
    await expect.poll(()=>codex.calls.filter(method=>method==="turn/steer").length).toBe(1);
    await expect(labels,"beta's card, its steer on its way").toHaveText(["Sending…","Queued"]);
    for(const name of ["Send now","Edit","Remove"])await expect(button("Queued beta",name)).toBeDisabled();
    await button("Queued beta","Remove").click({force:true});
    codex.steerHold.open();
    await expect(sent("Queued beta")).toHaveCount(1);await expect(queue).toHaveText(["Queued gamma"]);await expect(labels).toHaveText(["Queued"]);
    // gamma goes once alpha's turn ends, and its start fails: it is queued again, to retry, with its buttons on.
    context=gate();codex.holdTurns=false;
    await expect(sent("Queued gamma")).toBeVisible({timeout:10_000});codex.holdTurns=true;
    await expect(labels).toHaveText(["Sending…"]);await expect(button("Queued gamma","Remove")).toBeDisabled();
    context.open();await expect.poll(()=>codex.turns.length).toBe(3);codex.turns[2].fail("Deliberate queued start failure");
    await expect(page.getByTestId("composer-alert")).toHaveText("Queued follow-up not sent: Deliberate queued start failure.");
    await expect(labels).toHaveText(["Queued · retry needed"]);await expect(sent("Queued gamma")).toHaveCount(0);
    for(const name of ["Send now","Edit","Remove"])await expect(button("Queued gamma",name)).toBeEnabled();
    // Sent now, it is on its way again and says so until its turn starts.
    context=gate();await button("Queued gamma","Send now").click();
    await expect(sent("Queued gamma")).toBeVisible();await expect(labels).toHaveText(["Sending…"]);
    for(const name of ["Send now","Edit","Remove"])await expect(button("Queued gamma",name)).toBeDisabled();
    context.open();await expect.poll(()=>codex.turns.length).toBe(4);codex.turns[3].answer();codex.turns[3].start();
    await expect(page.locator(".queued-message")).toHaveCount(0);await expect(sent("Queued gamma")).toHaveCount(1);
    expect(codex.turns).toHaveLength(4);expect(codex.calls.filter(method=>method==="turn/steer")).toHaveLength(1);
  }finally{await codex.close()}
});

// A screenshot as a person pastes it: a PNG drawn in the page, handed over in the paste event's files.
const pasteImage=(page,name)=>composer(page).evaluate(async(node,name)=>{
  const canvas=document.createElement("canvas");canvas.width=64;canvas.height=40;const pen=canvas.getContext("2d");pen.fillStyle="#3b82f6";pen.fillRect(0,0,64,40);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png")),data=new DataTransfer();data.items.add(new File([blob],name,{type:"image/png"}));
  node.dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}));
},name);
// The files a request asks Codex to read, as codexTurnInput names them: a line after the text with the file's path, and an image
// item for an image.
const sentFiles=params=>{const input=params?.input||[];return [...String(input[0]?.text||"").matchAll(/\[Attached (image|file) "([^"]+)" is saved at: ([^\n]+)\]/g)].map(([,kind,name,path])=>kind+" "+name+(input.some(part=>part.type==="localImage"&&part.path===path)?" with its image item":"")+(path.endsWith(name)?"":" at "+path))};

// A follow-up's files go with it, as those of a message sent at once do: the one Send now steers into the running turn and the one
// the queue starts when the turn ends each name their files under their message, and Codex is asked with them, in Trebell's queue
// (a project thread's) as in Codex's (a General chat's, whose follow-ups Codex starts itself). One goes with a pasted screenshot,
// the other with a picked file.
for(const kind of ["Trebell","Codex"]){
  test(`a follow-up's files go to Codex with it and show under its message, sent now into the running turn or started from ${kind}'s queue when the turn ends`,async({page})=>{
    test.setTimeout(90_000);
    await page.setViewportSize({width:1280,height:800});
    const codex=await startCodex(page,{name:"Follow-ups with files",project:kind==="Trebell"});
    const queue=page.locator(".queued-message p"),chips=page.locator(".attachment-shelf > span"),files=text=>page.locator(".user-bubble").filter({hasText:text}).locator(".user-attachments > span");
    const pickFile=async(name,text)=>{const [chooser]=await Promise.all([page.waitForEvent("filechooser"),page.getByRole("button",{name:"Attach files",exact:true}).click()]);await chooser.setFiles([{name,mimeType:"text/plain",buffer:Buffer.from(text)}])};
    const askedFor=(method,text)=>codex.sent(method).find(params=>String(params.input?.[0]?.text||"").startsWith(text));
    try{
      codex.holdTurns=true;codex.drainQueue=true;
      await sendTyped(page,"Main task with a queue.");await expect.poll(()=>codex.turns.length).toBe(1);codex.turns[0].answer();codex.turns[0].start();
      await expect(stop(page)).toBeVisible();
      // alpha is queued with a pasted screenshot and beta with a picked file, each file leaving the composer with its follow-up.
      await typeInComposer(page,"Queued alpha with a screenshot");await pasteImage(page,"screenshot.png");await expect(chips).toHaveText(["screenshot.png"]);
      await page.keyboard.press("Enter");await expect(queue).toHaveText(["Queued alpha with a screenshot"]);await expect(chips).toHaveCount(0);
      await typeInComposer(page,"Queued beta with notes");await pickFile("notes.txt","Notes the follow-up takes along.");await expect(chips).toHaveText(["notes.txt"]);
      await composer(page).click();await page.keyboard.press("Enter");
      await expect(queue).toHaveText(["Queued alpha with a screenshot","Queued beta with notes"]);await expect(chips).toHaveCount(0);
      // Send now steers alpha into the running turn, its screenshot with it.
      await page.locator(".queued-message").filter({hasText:"Queued alpha"}).getByRole("button",{name:"Send now"}).click();
      await expect(files("Queued alpha"),"the message Send now steered in names its file").toHaveText(["screenshot.png"]);
      await expect(queue).toHaveText(["Queued beta with notes"]);
      expect(codex.sent("turn/steer").map(sentFiles),"what the steer asked Codex").toEqual([["image screenshot.png with its image item"]]);
      // The turn ends and the queue starts beta, its file with it: Trebell's queue in a turn/start, Codex's with what it was given
      // when beta was queued.
      codex.holdTurns=false;
      await expect.poll(()=>codex.turns.length,{timeout:15_000}).toBe(2);if(kind==="Trebell"){codex.turns[1].answer();codex.turns[1].start()}
      await expect(files("Queued beta"),"the message the queue started names its file").toHaveText(["notes.txt"]);
      expect(sentFiles(askedFor(kind==="Trebell"?"turn/start":"thread/queue/add","Queued beta")),"what Codex was asked for the follow-up the queue started").toEqual(["file notes.txt"]);
      await expect(page.locator(".queued-message")).toHaveCount(0);await expect(stop(page)).toHaveCount(0,{timeout:10_000});
      await expect(files("Queued alpha")).toHaveText(["screenshot.png"]);await expect(files("Main task")).toHaveCount(0);
      await page.locator(".user-bubble").filter({hasText:"Queued alpha"}).scrollIntoViewIfNeeded();await shoot(page,"follow-up-files-"+kind.toLowerCase()+"-queue");
    }finally{await codex.close()}
  });
}

// A Compact the harness refuses ends the one compaction row as failed; nothing is left saying it still compacts.
test("a Compact that fails ends its row as failed, with no compaction left running",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{name:"Codex compact"});
  try{
    codex.compactError="Deliberate compaction failure";
    await sendTyped(page,"Count from one to ten.");
    await expect.poll(()=>codex.turns.length).toBe(1);const [turn]=codex.turns;turn.answer();turn.start();
    await expect(page.getByText("Counting is done.",{exact:false})).toBeVisible({timeout:10_000});await expect(stop(page)).toHaveCount(0);
    await page.getByRole("button",{name:"Compact",exact:true}).click();
    const failed=page.locator(".tool-event").filter({hasText:"Context compaction failed: Deliberate compaction failure"});
    await expect(failed).toHaveCount(1);
    await expect(page.locator(".tool-event").filter({hasText:"Compacting context"})).toHaveCount(0);
    await expect(page.locator(".tool-event.status-running")).toHaveCount(0);
    await failed.scrollIntoViewIfNeeded();
    await shoot(page,"compact-failed");
  }finally{await codex.close()}
});

// A Compact that works is one row too: Compact shows it compacting, and the compaction's item (started and completed as Codex
// sends it, or only completed as the agent relay sends it for Grok and OpenCode) and thread/compacted end that same row
// compacted. The compaction's turn keeps the one row on its own card once the next turn starts. That card says how the compaction
// ended: the turn, which has no reply, has no row saying it finished without one, live or once the next turn starts, while an
// ordinary turn that ends with no reply still says so.
for(const order of ["Codex","the agent relay"]){
  test(`a Compact that works shows one row from compacting to compacted, with the compaction's events in ${order}'s order`,async({page})=>{
    test.setTimeout(60_000);
    await page.setViewportSize({width:1280,height:800});
    const codex=await startCodex(page,{name:"Codex compact"});
    const rows=page.locator(".tool-event").filter({hasText:/compact/i}),meter=page.locator(".context-meter");
    const usage=percent=>({threadId:codex.thread.id,tokenUsage:{modelContextWindow:100_000,last:{inputTokens:percent*1000},total:{totalTokens:130_000}}});
    try{
      await sendTyped(page,"Count from one to ten.");
      await expect.poll(()=>codex.turns.length).toBe(1);const [turn]=codex.turns;turn.answer();turn.start();
      await expect(page.getByText("Counting is done.",{exact:false})).toBeVisible({timeout:10_000});await expect(stop(page)).toHaveCount(0);
      codex.notify("thread/tokenUsage/updated",usage(93));await expect(meter).toHaveAttribute("aria-valuenow","93");
      await page.getByRole("button",{name:"Compact",exact:true}).click();
      await expect.poll(()=>codex.calls.includes("thread/compact/start")).toBe(true);
      await expect(rows).toHaveCount(1);await expect(rows).toHaveClass(/status-running/);await expect(rows.locator("summary strong")).toHaveText("Compacting context");
      const threadId=codex.thread.id,turnId="codex-compact-turn",item={type:"contextCompaction",id:"compaction-item-1"};
      codex.notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress",items:[]}});await expect(stop(page)).toBeVisible();
      if(order==="Codex"){
        // The usage sent after the item shows once the item is in.
        codex.notify("item/started",{threadId,turnId,item});codex.notify("thread/tokenUsage/updated",usage(94));await expect(meter).toHaveAttribute("aria-valuenow","94");
        await expect(rows).toHaveCount(1);await expect(rows).toHaveClass(/status-running/);await expect(rows.locator("summary strong")).toHaveText("Compacting context");
      }
      codex.notify("item/completed",{threadId,turnId,item,completedAtMs:Date.now()});codex.notify("thread/compacted",{threadId,turnId});
      codex.notify("thread/tokenUsage/updated",usage(21));codex.notify("turn/completed",{threadId,turn:{id:turnId,status:"completed",items:[]}});
      await expect(meter).toHaveAttribute("aria-valuenow","21");await expect(stop(page)).toHaveCount(0);
      await expect(rows).toHaveCount(1);await expect(rows).toHaveClass(/status-done/);await expect(rows.locator("summary strong")).toHaveText("Context compacted");
      const ended=page.locator(`[data-testid=turn-outcome-row][data-turn-id="${turnId}"]`),noReply=page.getByText("Finished without a reply.",{exact:true});
      await expect(ended,"the compaction's turn has a row saying it finished without a reply").toHaveCount(0);await expect(noReply).toHaveCount(0);
      await rows.scrollIntoViewIfNeeded();await shoot(page,"compact-one-row");
      await sendTyped(page,"Count again.");
      await expect.poll(()=>codex.turns.length).toBe(2);const next=codex.turns[1];next.answer();next.start();
      await expect(page.getByText("Counting is done.",{exact:false})).toHaveCount(2,{timeout:10_000});await expect(stop(page)).toHaveCount(0);
      const card=page.locator(`[data-testid=activity-card][data-turn-id="${turnId}"]`);
      await expect(card.locator(".activity-card-summary")).toHaveText("1 step");
      await expect(card).toHaveAttribute("data-state","closed");await card.locator(".activity-card-head").click();
      await expect(rows).toHaveCount(1);await expect(card.locator(".tool-event summary strong")).toHaveText("Context compacted");
      await expect(ended).toHaveCount(0);await expect(noReply).toHaveCount(0);
      // A turn of the person's that Codex ends with no reply still says so, under its message.
      await sendTyped(page,"Format the code.");
      await expect.poll(()=>codex.turns.length).toBe(3);const quiet=codex.turns[2];quiet.answer();
      codex.notify("turn/started",{threadId,turn:{id:quiet.id,status:"inProgress",items:[]}});await expect(stop(page)).toBeVisible();
      quiet.status="completed";codex.notify("turn/completed",{threadId,turn:{id:quiet.id,status:"completed",items:[]}});await expect(stop(page)).toHaveCount(0);
      await expect(page.locator(`[data-testid=turn-outcome-row][data-turn-id="${quiet.id}"] .turn-outcome-message`)).toHaveText("Finished without a reply.");
      await expect(noReply).toHaveCount(1);await expect(ended).toHaveCount(0);
    }finally{await codex.close()}
  });
}

// A double click on Compact compacts once. Its first click compacts and Compact goes while the compaction's turn runs, so the second
// lands where Compact was, beside the meter's reading: it does nothing there, as the rest of a press on a queued follow-up's buttons
// does nothing, and no text of the composer's footer is selected, then or once Compact is back. At 1280 and 900 wide.
test("a double click on Compact compacts once, and its second click, where Compact was, selects nothing",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{name:"Codex compact"});
  const compact=page.getByRole("button",{name:"Compact",exact:true}),meter=page.locator(".context-meter"),selected=()=>page.evaluate(()=>String(getSelection()));
  const usage=percent=>({threadId:codex.thread.id,tokenUsage:{modelContextWindow:100_000,last:{inputTokens:percent*1000},total:{totalTokens:130_000}}});
  try{
    await sendTyped(page,"Count from one to ten.");
    await expect.poll(()=>codex.turns.length).toBe(1);const [turn]=codex.turns;turn.answer();turn.start();
    await expect(page.getByText("Counting is done.",{exact:false})).toBeVisible({timeout:10_000});await expect(stop(page)).toHaveCount(0);
    const threadId=codex.thread.id,compactions=()=>codex.calls.filter(method=>method==="thread/compact/start").length;
    for(const [index,width] of [[1,1280],[2,900]]){
      await page.setViewportSize({width,height:800});
      codex.notify("thread/tokenUsage/updated",usage(93));await expect(meter).toHaveAttribute("aria-valuenow","93");
      const box=await compact.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2,turnId="codex-compact-turn-"+index;
      await page.mouse.move(x,y);await page.mouse.down();await page.mouse.up();
      await expect.poll(compactions).toBe(index);
      codex.notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress",items:[]}});await expect(compact).toHaveCount(0);
      await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});
      expect.soft(await selected(),"the second click of the double click selected text where Compact was").toBe("");
      const item={type:"contextCompaction",id:"compaction-item-"+index};
      codex.notify("item/started",{threadId,turnId,item});codex.notify("item/completed",{threadId,turnId,item,completedAtMs:Date.now()});codex.notify("thread/compacted",{threadId,turnId});
      codex.notify("thread/tokenUsage/updated",usage(21));codex.notify("turn/completed",{threadId,turn:{id:turnId,status:"completed",items:[]}});
      await expect(meter).toHaveAttribute("aria-valuenow","21");await expect(compact).toBeVisible();
      expect(compactions(),"a double click on Compact compacted twice").toBe(index);
      expect(await selected(),"the meter's reading and Compact are selected once Compact is back").toBe("");
    }
    await page.setViewportSize({width:1280,height:800});await shoot(page,"compact-double-click");
  }finally{await codex.close()}
});

// Codex compacts by itself in the middle of a turn each time the context fills up: two compactions in one turn are two rows, live and
// on the turn's card once the next turn starts, as the turn's history holds them (each compaction an item of its own).
test("two compactions Codex makes in one turn are two rows, live and on the turn's card",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{name:"Codex compact"});
  const rows=page.locator(".tool-event").filter({hasText:/Compacting context|Context compacted/});
  try{
    codex.holdTurns=true;
    await sendTyped(page,"Count from one to ten.");
    await expect.poll(()=>codex.turns.length).toBe(1);const [turn]=codex.turns;turn.answer();turn.start();
    await expect(page.getByText("Counting is done.",{exact:false})).toBeVisible({timeout:10_000});await expect(stop(page)).toBeVisible();
    const threadId=codex.thread.id;
    for(const id of ["compaction-item-1","compaction-item-2"]){
      codex.notify("item/started",{threadId,turnId:turn.id,item:{type:"contextCompaction",id}});
      codex.notify("item/completed",{threadId,turnId:turn.id,item:{type:"contextCompaction",id}});
      codex.notify("thread/compacted",{threadId,turnId:turn.id});
    }
    await expect(rows).toHaveCount(2);await expect(rows.locator("summary strong")).toHaveText(["Context compacted","Context compacted"]);
    codex.holdTurns=false;await expect(stop(page)).toHaveCount(0,{timeout:10_000});
    await sendTyped(page,"Count again.");
    await expect.poll(()=>codex.turns.length).toBe(2);const next=codex.turns[1];next.answer();next.start();
    await expect(page.getByText("Counting is done.",{exact:false})).toHaveCount(2,{timeout:10_000});await expect(stop(page)).toHaveCount(0);
    const card=page.locator(`[data-testid=activity-card][data-turn-id="${turn.id}"]`);
    await expect(card.locator(".activity-card-summary")).toContainText("2 steps");
    if(await card.getAttribute("data-state")==="closed")await card.locator(".activity-card-head").click();
    await expect(card.locator(".tool-event summary strong")).toHaveText(["Context compacted","Context compacted"]);
    await card.scrollIntoViewIfNeeded();await shoot(page,"two-compactions-one-turn");
  }finally{await codex.close()}
});

// A compaction that never completes says so, live and on its turn's card once the next turn starts: one stopped while it compacts
// is not called compacted, and one Codex fails reads failed. Codex sends its item's start, then the interrupt's end or the error,
// and never the item's completion or thread/compacted.
for(const end of ["Stop","a Codex error"]){
  test(`a compaction ended by ${end} before it completes never reads compacted, live or on its turn's card`,async({page})=>{
    test.setTimeout(60_000);
    await page.setViewportSize({width:1280,height:800});
    const codex=await startCodex(page,{name:"Codex compact"});
    // The compaction's row (Codex's error has a row of its own, which leaves with its turn).
    const rows=page.locator(".tool-event").filter({hasText:/Compacting context|Context compact(ed|ion failed)/});
    try{
      await sendTyped(page,"Count from one to ten.");
      await expect.poll(()=>codex.turns.length).toBe(1);const [turn]=codex.turns;turn.answer();turn.start();
      await expect(page.getByText("Counting is done.",{exact:false})).toBeVisible({timeout:10_000});await expect(stop(page)).toHaveCount(0);
      await page.getByRole("button",{name:"Compact",exact:true}).click();
      await expect.poll(()=>codex.calls.includes("thread/compact/start")).toBe(true);
      const threadId=codex.thread.id,turnId="codex-compact-turn";
      codex.notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress",items:[]}});await expect(stop(page)).toBeVisible();
      codex.notify("item/started",{threadId,turnId,item:{type:"contextCompaction",id:"compaction-item-1"}});
      await expect(rows).toHaveCount(1);await expect(rows.locator("summary strong")).toHaveText("Compacting context");
      if(end==="Stop"){
        await stop(page).click();await expect.poll(()=>codex.interrupts).toEqual([{threadId,turnId}]);
        codex.notify("turn/completed",{threadId,turn:{id:turnId,status:"interrupted",items:[]}});
      }else{
        codex.notify("error",{threadId,turnId,willRetry:false,error:{message:"Deliberate compaction failure"}});
        await expect(rows.locator("summary strong")).toHaveText("Context compaction failed: Deliberate compaction failure");
        codex.notify("turn/completed",{threadId,turn:{id:turnId,status:"failed",items:[],error:{message:"Deliberate compaction failure"}}});
      }
      await expect(stop(page)).toHaveCount(0);
      const said=end==="Stop"?"Compacting context":"Context compaction failed: Deliberate compaction failure";
      await expect(rows).toHaveCount(1);await expect(rows.locator("summary strong")).toHaveText(said);await expect(rows).not.toHaveClass(/status-running/);
      // The next turn takes the live card; the compaction's turn keeps its one row on its own card, as it ended.
      await sendTyped(page,"Count again.");
      await expect.poll(()=>codex.turns.length).toBe(2);const next=codex.turns[1];next.answer();next.start();
      await expect(page.getByText("Counting is done.",{exact:false})).toHaveCount(2,{timeout:10_000});await expect(stop(page)).toHaveCount(0);
      const card=page.locator(`[data-testid=activity-card][data-turn-id="${turnId}"]`);
      await expect(card.locator(".activity-card-summary")).toContainText("1 step");
      await expect(card).toHaveAttribute("data-state","closed");await card.locator(".activity-card-head").click();
      await expect(card.locator(".tool-event summary strong")).toHaveText(said);
      await expect(page.locator(".tool-event").filter({hasText:"Context compacted"})).toHaveCount(0);
      await card.scrollIntoViewIfNeeded();await shoot(page,"compact-ended-by-"+(end==="Stop"?"stop":"error"));
    }finally{await codex.close()}
  });
}

// Editing a queued follow-up in the composer sets the composer's draft aside: the draft comes back once the edit is saved, and Escape
// ends an edit with the queued message as it was. Trebell Native keeps its queue in the relay; a Codex project thread keeps its own
// in Trebell.
for(const kind of ["native","local"]){
  test(`editing a ${kind} queued follow-up keeps the composer's draft, and Escape ends the edit with the message unchanged`,async({page})=>{
    test.setTimeout(90_000);
    await page.setViewportSize({width:1280,height:800});
    let fixture=null,codex=null;const finish=gate();
    try{
      if(kind==="native"){
        await keepSettings(page);
        fixture=await startStreamingFixture(page,{threads:[{name:"Queue edits",preview:"Queue"}]});const streamed=gate();
        answerBy(fixture,[["Main task",async(request,hook)=>{hook({type:"text",delta:"Working on the main task. "});streamed.open();await Promise.race([finish.promise,untilAborted(request.signal)]);return reply(request,"Main task done.")}]]);
        await fixture.open("Queue edits");await sendTyped(page,"Main task with a queue.");await streamed.promise;
      }else{
        codex=await startCodex(page,{name:"Queue edits",project:true});codex.holdTurns=true;
        await sendTyped(page,"Main task with a queue.");await expect.poll(()=>codex.turns.length).toBe(1);codex.turns[0].answer();codex.turns[0].start();
      }
      await expect(stop(page)).toBeVisible();
      for(const text of ["Queued alpha","Queued beta"]){await sendTyped(page,text);await expect(page.locator(".queued-message").filter({hasText:text})).toHaveCount(1)}
      const alpha=page.locator(".queued-message").filter({hasText:"Queued alpha"}),beta=page.locator(".queued-message").filter({hasText:"Queued beta"});
      await typeInComposer(page,"My unsent draft that matters");
      await beta.getByRole("button",{name:"Edit",exact:true}).click();
      await expect(composer(page)).toHaveValue("Queued beta");await expect(beta).toContainText("editing · your draft returns after");await expect(page.locator(".queued-message")).toHaveCount(2);
      await expect(page.locator(".composer-hints")).toHaveText("Save editEnter · CancelEsc");
      // Its Send now waits for the edit, so it never sends the queued text the composer is changing.
      await expect(beta.getByRole("button",{name:"Send now"})).toBeDisabled();
      await expect(beta.getByRole("button",{name:"Send now"})).toHaveAttribute("title","Save the edit with Enter, or press Escape, before sending it");
      if(kind==="native")await shoot(page,"queue-edit-with-draft");
      // Saved, the edit replaces the queued message in its place, and the draft is back in the composer.
      await composer(page).click();await page.keyboard.press("End");await page.keyboard.type(" (edited)",{delay:8});await page.keyboard.press("Enter");
      await expect(page.locator(".queued-message p")).toHaveText(["Queued alpha","Queued beta (edited)"]);
      await expect(composer(page)).toHaveValue("My unsent draft that matters");await expect(page.locator(".queued-message.editing")).toHaveCount(0);
      await expect(page.locator(".composer-hints")).toContainText("Queue follow-ups");
      // Escape ends an edit and leaves the message as it was; the draft comes back.
      await alpha.getByRole("button",{name:"Edit",exact:true}).click();await expect(composer(page)).toHaveValue("Queued alpha");
      await composer(page).click();await page.keyboard.press("End");await page.keyboard.type(" never saved",{delay:8});
      await page.keyboard.press("Escape");
      await expect(page.locator(".queued-message.editing")).toHaveCount(0);await expect(alpha.getByRole("button",{name:"Edit",exact:true})).toBeEnabled();
      await expect(page.locator(".queued-message p")).toHaveText(["Queued alpha","Queued beta (edited)"]);
      await expect(composer(page)).toHaveValue("My unsent draft that matters");
      if(kind==="native")await shoot(page,"queue-edit-escaped");
    }finally{finish.open();if(fixture)await fixture.close();if(codex)await codex.close()}
  });
}

// New task asked for while the new task is what the person left (Settings, another page) or is on keeps its unsent draft.
test("New task keeps an unsent new-task draft, coming back from Settings and pressed again on the new task",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  await keepSettings(page);
  const fixture=await startStreamingFixture(page,{threads:[{name:"Older work",preview:"Older"}]});
  try{
    await expect(threadRow(page,"Older work")).toBeVisible();
    await newTask(page).click();await expect(page.locator(".workspace-header")).toContainText("New Trebell task");
    await typeInComposer(page,"A new task I have not sent yet");
    await page.getByRole("button",{name:"Settings",exact:true}).click();
    await expect(composer(page)).toHaveCount(0);
    await newTask(page).click();
    await expect(composer(page)).toHaveValue("A new task I have not sent yet");
    await shoot(page,"new-task-draft-after-settings");
    await newTask(page).click();
    await expect(composer(page)).toHaveValue("A new task I have not sent yet");
    await page.keyboard.press("Control+n");
    await expect(composer(page)).toHaveValue("A new task I have not sent yet");
  }finally{await fixture.close()}
});

// The thread "Slow start", whose first send waits on its repository context until releaseContext(); contextCalls() counts the
// context requests.
async function slowStartFixture(page){
  await keepSettings(page);
  const fixture=await startStreamingFixture(page,{threads:[{name:"Slow start",preview:"Slow"}]});
  let releaseContext=()=>{},calls=0;const contextHeld=new Promise(resolve=>{releaseContext=resolve});
  await page.route(/\/api\/context\/packet$/,async route=>{if(!calls++)await contextHeld;await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"held-context",skipped:true,budget:{reserveTokens:1024}})}).catch(()=>{})});
  answerBy(fixture,[["Slow start task",async request=>reply(request,"The slow start answered in its own thread.")],["Quick task",async request=>reply(request,"The quick task answered at once.")]]);
  return {fixture,releaseContext,contextCalls:()=>calls};
}

// A send still on its way in the thread left (here its repository context is slow) is that thread's: the new task opened meanwhile
// does not wait for it and sends at once, and the first send goes on to run in its own thread.
test("a new task opened while another thread's send is on its way is idle and sends at once, and the first send runs in its thread",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const {fixture,releaseContext,contextCalls}=await slowStartFixture(page);
  try{
    await fixture.open("Slow start");
    await sendTyped(page,"Slow start task.");
    await expect(composer(page)).toHaveAttribute("placeholder","Sending…");await expect.poll(contextCalls).toBe(1);
    await newTask(page).click();
    await expectIdleNewTask(page);
    await shoot(page,"new-task-while-another-sends");
    await sendTyped(page,"Quick task.");
    await expect(page.getByText("The quick task answered at once.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(stop(page)).toHaveCount(0);
    releaseContext();
    // The first send runs in its own thread, and the thread shown stays as it is.
    await expect.poll(()=>fixture.threadStore.get(fixture.threads[0].id).turns.at(-1)?.status,{timeout:15_000}).toBe("completed");
    await page.waitForTimeout(300);
    await expect(stop(page)).toHaveCount(0);await expect(composer(page)).toHaveAttribute("placeholder",IDLE_PLACEHOLDER);await expect(composer(page)).toHaveValue("");
    await expect(page.getByText("The slow start answered in its own thread.",{exact:true})).toHaveCount(0);
    await threadRow(page,"Slow start").locator(".thread-main").click();
    await expect(page.getByText("The slow start answered in its own thread.",{exact:true})).toBeVisible({timeout:10_000});
  }finally{releaseContext();await fixture.close()}
});

// Opened again before that send is through, the thread shows it: its message, Stop, and its composer held as Sending, so nothing more
// goes to the thread meanwhile; the reply then lands there.
test("a thread opened again while its send is on its way shows that send, and its reply lands there",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const {fixture,releaseContext,contextCalls}=await slowStartFixture(page);
  try{
    await fixture.open("Slow start");
    await sendTyped(page,"Slow start task.");await expect.poll(contextCalls).toBe(1);
    await newTask(page).click();await expectIdleNewTask(page);
    await threadRow(page,"Slow start").locator(".thread-main").click();
    await expect(stop(page)).toBeVisible({timeout:10_000});await expect(page.locator(".user-row")).toHaveText([/^Slow start task\./]);
    await expect(composer(page)).toHaveAttribute("placeholder","Sending…");await expect(composer(page)).toBeDisabled();
    await shoot(page,"thread-opened-again-while-sending");
    releaseContext();
    await expect(page.getByText("The slow start answered in its own thread.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(stop(page)).toHaveCount(0);await expect(composer(page)).toHaveAttribute("placeholder",IDLE_PLACEHOLDER);await expect(composer(page)).toBeEnabled();
    await expect(page.locator(".user-row")).toHaveText([/^Slow start task\./]);
    expect(fixture.threadStore.get(fixture.threads[0].id).turns).toHaveLength(1);
  }finally{releaseContext();await fixture.close()}
});

// Stop there ends that send, also once the new task has sent one of its own meanwhile: no turn runs, and the draft is back in the
// thread's composer.
test("Stop in a thread opened again while its send waits ends that send, also after a new task sent its own",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const {fixture,releaseContext,contextCalls}=await slowStartFixture(page);
  try{
    await fixture.open("Slow start");
    await sendTyped(page,"Slow start task.");await expect.poll(contextCalls).toBe(1);
    await newTask(page).click();await expectIdleNewTask(page);
    await sendTyped(page,"Quick task.");
    await expect(page.getByText("The quick task answered at once.",{exact:true})).toBeVisible({timeout:15_000});await expect(stop(page)).toHaveCount(0);
    await threadRow(page,"Slow start").locator(".thread-main").click();
    await expect(stop(page)).toBeVisible({timeout:10_000});
    await stop(page).click();await expect(stopping(page)).toBeVisible();
    releaseContext();
    await expect(stopping(page)).toHaveCount(0,{timeout:10_000});await expect(stop(page)).toHaveCount(0);
    await expect(composer(page)).toHaveValue("Slow start task.");await expect(page.locator(".user-row")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(fixture.threadStore.get(fixture.threads[0].id).turns).toHaveLength(0);
  }finally{releaseContext();await fixture.close()}
});

// A send still on its way belongs to its thread: another thread opened meanwhile has its own composer, free to type and send, as a new
// task has, and the first send goes on in its own thread.
test("another thread opened while a send waits for Codex has its own composer, free to type and send",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{names:["Codex sender","Codex other"]});
  try{
    await sendTyped(page,"Count from one to forty, one number per line.");
    await expect.poll(()=>codex.turns.length).toBe(1);await expect(composer(page)).toHaveAttribute("placeholder",/^Sending/);
    await threadRow(page,"Codex other").locator(".thread-main").click();
    await expect(page.locator(".workspace-header")).toContainText("Codex other");
    await expect(composer(page)).toHaveAttribute("placeholder",IDLE_PLACEHOLDER);await expect(composer(page)).toBeEnabled();
    await shoot(page,"another-thread-free-while-a-send-waits");
    await sendTyped(page,"Reply in the other thread.");
    await expect.poll(()=>codex.turns.length,{timeout:5000}).toBe(2);
    const [first,second]=codex.turns;expect(second.threadId).toBe(codex.threads[1].id);
    second.answer();second.start();
    await expect(page.getByText("Counting is done.",{exact:false})).toBeVisible({timeout:10_000});
    first.answer();first.start();
    await expect.poll(()=>first.status,{timeout:10_000}).toBe("completed");
    await threadRow(page,"Codex sender").locator(".thread-main").click();
    await expect(page.locator(".workspace-header")).toContainText("Codex sender");
    await expect(composer(page)).toHaveAttribute("placeholder",IDLE_PLACEHOLDER);await expect(stop(page)).toHaveCount(0);
  }finally{await codex.close()}
});

// A new task's send whose thread is still being made (Trebell's tool catalog still loading, or the new thread's workspace save on its
// way) when the person opens another thread: the thread opened stays shown with its own history, and the new task's thread starts on
// its own in the sidebar, with its message and reply there once it is opened.
for(const held of ["the tool catalog","the new thread's workspace save"])test(`a thread opened while a new task's send waits for ${held} stays shown when that send's thread starts`,async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const heldRoutes=[],catalog=held==="the tool catalog";let holding=true;
  if(catalog)await page.route(/\/assets\/shared-tool-catalog-[^/]*\.js$/,route=>{heldRoutes.push(route)});
  const fixture=await startStreamingFixture(page,{threads:[{name:"Other work",preview:"Other"}],providerTurn:async request=>reply(request,"The new task answered in its own thread.")});
  const other=fixture.threads[0],known=new Set(fixture.threads.map(thread=>String(thread.id)));
  if(!catalog)await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{
    const body=route.request().method()==="POST"?route.request().postDataJSON():null;
    if(holding&&body&&!known.has(String(body.threadId||"")))heldRoutes.push(route);else await route.fallback();
  });
  const turn=fixture.threadStore.addTurn(other.id,{inputText:"What does the other thread hold?"});
  fixture.threadStore.addItem(other.id,turn.id,{id:"other-answer",type:"agentMessage",text:"The other thread's own answer."});fixture.threadStore.finishTurn(other.id,turn.id);
  try{
    if(catalog)await expect.poll(()=>heldRoutes.length,{message:"the catalog asked for at idle"}).toBe(1);
    const before=fixture.threadStore.list("native").length;
    await fixture.send("A new task sent while it waits");
    await expect(composer(page)).toHaveValue("");
    if(!catalog)await expect.poll(()=>heldRoutes.length,{timeout:10_000}).toBe(1);
    await threadRow(page,"Other work").locator(".thread-main").click();
    await expect(page.locator(".workspace-header")).toContainText("Other work",{timeout:10_000});
    await expect(page.getByText("The other thread's own answer.",{exact:true})).toBeVisible({timeout:10_000});
    holding=false;for(const route of heldRoutes.splice(0))await (catalog?route.continue():route.fallback());
    await expect.poll(()=>fixture.threadStore.list("native").length,{timeout:15_000}).toBe(before+1);
    const sent=fixture.threadStore.list("native").find(thread=>!known.has(String(thread.id)));
    await expect.poll(()=>fixture.threadStore.get(sent.id).turns.at(-1)?.status,{timeout:15_000}).toBe("completed");
    await page.waitForTimeout(300);
    // The thread opened is still the one shown, with its own history only, and nothing of the send.
    await expect(page.locator(".workspace-header")).toContainText("Other work");
    await expect(threadRow(page,"Other work")).toHaveClass(/active/);
    await expect(page.locator(".user-row")).toHaveCount(1);await expect(page.locator(".user-row")).toContainText("What does the other thread hold?");
    await expect(stop(page)).toHaveCount(0);await expect(composer(page)).toHaveAttribute("placeholder",IDLE_PLACEHOLDER);
    // The send ran in its own thread, which is in the sidebar and shows its message and reply once opened.
    const sentRow=page.locator(`.thread-row[data-thread-id="${sent.id}"]`);
    await expect(sentRow).toBeVisible();await expect(sentRow).not.toHaveClass(/active/);await sentRow.locator(".thread-main").click();
    await expect(page.locator(".user-row").filter({hasText:"A new task sent while it waits"})).toBeVisible({timeout:10_000});
    await expect(page.getByText("The new task answered in its own thread.",{exact:true})).toBeVisible({timeout:10_000});
  }finally{for(const route of heldRoutes)await route.continue().catch(()=>{});await fixture.close()}
});

// While a send is on its way its files are its own thread's. When the person opens another thread meanwhile, that thread's composer
// shows none of them, so a send made there cannot carry them; they go with their own send, and a file attached there stays. Here a
// new task's send waits for the tool catalog.
test("a new task's file sent while another thread is opened is never in that thread's composer, and a file attached there stays",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const heldRoutes=[],asked=[];
  await page.route(/\/assets\/shared-tool-catalog-[^/]*\.js$/,route=>{heldRoutes.push(route)});
  const fixture=await startStreamingFixture(page,{threads:[{name:"Other work",preview:"Other"}],providerTurn:async request=>{asked.push(JSON.stringify(request.messages||[]));return reply(request,"The new task answered in its own thread.")}});
  const other=fixture.threads[0],known=new Set(fixture.threads.map(thread=>String(thread.id)));
  const turn=fixture.threadStore.addTurn(other.id,{inputText:"What does the other thread hold?"});
  fixture.threadStore.addItem(other.id,turn.id,{id:"other-answer",type:"agentMessage",text:"The other thread's own answer."});fixture.threadStore.finishTurn(other.id,turn.id);
  const shelf=page.locator(".attachment-shelf > span");
  const attach=async(name,text)=>{const [chooser]=await Promise.all([page.waitForEvent("filechooser"),page.getByRole("button",{name:"Attach files",exact:true}).click()]);await chooser.setFiles([{name,mimeType:"text/plain",buffer:Buffer.from(text)}])};
  try{
    await expect.poll(()=>heldRoutes.length,{message:"the catalog asked for at idle"}).toBe(1);
    await attach("notes.txt","notes for the new task");await expect(shelf).toHaveCount(1,{timeout:10_000});
    const before=fixture.threadStore.list("native").length;
    await fixture.send("A new task with a file");
    await expect(composer(page)).toHaveValue("");
    await threadRow(page,"Other work").locator(".thread-main").click();
    await expect(page.locator(".workspace-header")).toContainText("Other work",{timeout:10_000});
    await expect(page.getByText("The other thread's own answer.",{exact:true})).toBeVisible({timeout:10_000});
    expect(fixture.threadStore.list("native").length,"the new task's send is still on its way").toBe(before);
    await expect(shelf,"the thread opened shows none of the new task's files").toHaveCount(0);
    await attach("other.txt","a file for the other thread");await expect(shelf).toHaveCount(1,{timeout:10_000});
    await expect(page.locator(".attachment-shelf")).toContainText("other.txt");await expect(page.locator(".attachment-shelf")).not.toContainText("notes.txt");
    await page.screenshot({animations:"disabled",path:auditDir+"turn-controls-sent-files-stay-with-their-send-dark-1280x800.png"});
    for(const route of heldRoutes.splice(0))await route.continue();
    await expect.poll(()=>fixture.threadStore.list("native").length,{timeout:15_000}).toBe(before+1);
    const sent=fixture.threadStore.list("native").find(thread=>!known.has(String(thread.id)));
    await expect.poll(()=>fixture.threadStore.get(sent.id).turns.at(-1)?.status,{timeout:15_000}).toBe("completed");
    const request=asked.find(text=>text.includes("A new task with a file"))||"";
    expect(request,"the new task's request carries its own file").toContain("notes.txt");expect(request,"and not the other thread's").not.toContain("other.txt");
    // The thread opened is still shown, its composer holds the file attached there only.
    await expect(page.locator(".workspace-header")).toContainText("Other work");
    await expect(shelf).toHaveCount(1,{timeout:5000});
    await expect(page.locator(".attachment-shelf")).toContainText("other.txt");await expect(page.locator(".attachment-shelf")).not.toContainText("notes.txt");
  }finally{for(const route of heldRoutes)await route.continue().catch(()=>{});await fixture.close()}
});

// A workspace file the person mentions in another thread while the first thread's send of the same file waits stays attached there
// once that send's turn starts: the send's own files left the composer when the other thread was opened, so nothing takes this one.
test("a workspace file mentioned in another thread while a send of the same file waits stays attached there once that turn starts",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const asked=[];
  const fixture=await startStreamingFixture(page,{threads:[{name:"Sending work",preview:"Sending"},{name:"Other work",preview:"Other"}],providerTurn:async request=>{asked.push(JSON.stringify(request.messages||[]));return reply(request,"Answered.")}});
  const [sending]=fixture.threads;
  for(const [thread,text] of [[fixture.threads[0],"The sending thread's own answer."],[fixture.threads[1],"The other thread's own answer."]]){const turn=fixture.threadStore.addTurn(thread.id,{inputText:"What is here?"});fixture.threadStore.addItem(thread.id,turn.id,{id:thread.id+"-answer",type:"agentMessage",text});fixture.threadStore.finishTurn(thread.id,turn.id)}
  const file=join(fixture.repo,"session.js");
  await page.route(/\/api\/workspace\/search(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:[{path:file,name:"session.js",relativePath:"session.js"}]})}));
  const held=[];let holding=true;
  await page.route(/\/api\/checkpoints$/,route=>{if(holding&&route.request().method()==="POST"){held.push(route);return}return route.fallback()});
  const chips=page.getByTestId("context-chip");
  const mention=async()=>{await composer(page).fill("@session");await expect(page.getByTestId("file-mention-menu")).toBeVisible({timeout:10_000});await page.getByTestId("file-mention-menu").getByRole("button").first().click();await expect(chips).toHaveCount(1,{timeout:10_000})};
  const openRow=async(name,answer)=>{await threadRow(page,name).locator(".thread-main").click();await expect(page.locator(".workspace-header")).toContainText(name,{timeout:10_000});await expect(page.getByText(answer,{exact:true})).toBeVisible({timeout:10_000})};
  try{
    await openRow("Sending work","The sending thread's own answer.");
    await mention();
    await composer(page).fill("Use the session file.");await page.getByTestId("send").click();
    await expect.poll(()=>held.length,{message:"the send waits for its checkpoint"}).toBe(1);
    const turnsBefore=fixture.threadStore.get(sending.id).turns.length;
    await openRow("Other work","The other thread's own answer.");
    await expect(chips,"the other thread shows none of the sending thread's files").toHaveCount(0);
    await mention();
    holding=false;for(const route of held.splice(0))await route.fallback();
    await expect.poll(()=>fixture.threadStore.get(sending.id).turns.length,{timeout:15_000}).toBe(turnsBefore+1);
    await expect.poll(()=>fixture.threadStore.get(sending.id).turns.at(-1)?.status,{timeout:15_000}).toBe("completed");
    await page.waitForTimeout(500);
    await page.screenshot({animations:"disabled",path:SHOTS+"F4-same-file-stays-in-other-thread.png"});
    await expect(chips,"the chip the person added in Other work still shows").toHaveCount(1);
    await composer(page).fill("Explain it.");await page.getByTestId("send").click();
    await expect.poll(()=>asked.find(text=>text.includes("Explain it."))||"",{timeout:15_000}).not.toBe("");
    const firstRequest=asked.find(text=>text.includes("Use the session file."))||"",otherRequest=asked.find(text=>text.includes("Explain it."));
    console.log("first send carried session.js:",firstRequest.includes("session.js"),"other send carried session.js:",otherRequest.includes("session.js"));
    expect(firstRequest.includes("session.js"),"the first send carries its file").toBe(true);
    expect(otherRequest.includes("session.js"),"the Other work send carries the file its chip shows").toBe(true);
  }finally{for(const route of held)await route.fallback().catch(()=>{});await fixture.close()}
});

// The same for a thread's own send, which waits here for its file checkpoint: the file leaves the composer with the thread left, is
// back in it (held as Sending) when that thread is opened again while the send still waits, and goes with that thread's turn.
test("a thread's file sent and left for another thread before its turn starts shows only in its own thread's composer until the turn starts",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const asked=[];
  const fixture=await startStreamingFixture(page,{threads:[{name:"Sending work",preview:"Sending"},{name:"Other work",preview:"Other"}],providerTurn:async request=>{asked.push(JSON.stringify(request.messages||[]));return reply(request,"The sending thread answered.")}});
  const [sending,other]=fixture.threads;
  for(const [thread,text] of [[sending,"The sending thread's own answer."],[other,"The other thread's own answer."]]){const turn=fixture.threadStore.addTurn(thread.id,{inputText:"What is here?"});fixture.threadStore.addItem(thread.id,turn.id,{id:thread.id+"-answer",type:"agentMessage",text});fixture.threadStore.finishTurn(thread.id,turn.id)}
  const held=[];
  await page.route(/\/api\/checkpoints$/,route=>{if(route.request().method()==="POST"){held.push(route);return}return route.fallback()});
  const shelf=page.locator(".attachment-shelf > span");
  const attach=async(name,text)=>{const [chooser]=await Promise.all([page.waitForEvent("filechooser"),page.getByRole("button",{name:"Attach files",exact:true}).click()]);await chooser.setFiles([{name,mimeType:"text/plain",buffer:Buffer.from(text)}])};
  const openRow=async(name,answer)=>{await threadRow(page,name).locator(".thread-main").click();await expect(page.locator(".workspace-header")).toContainText(name,{timeout:10_000});await expect(page.getByText(answer,{exact:true})).toBeVisible({timeout:10_000})};
  try{
    await openRow("Sending work","The sending thread's own answer.");
    await attach("notes.txt","notes for the sending thread");await expect(shelf).toHaveCount(1,{timeout:10_000});
    const turnsBefore=fixture.threadStore.get(sending.id).turns.length;
    await fixture.send("Use the notes.");
    await expect.poll(()=>held.length,{message:"the send waits for its checkpoint"}).toBe(1);
    await openRow("Other work","The other thread's own answer.");
    await expect(shelf,"the thread opened shows none of the sending thread's files").toHaveCount(0);
    await openRow("Sending work","The sending thread's own answer.");
    await expect(composer(page)).toBeDisabled();
    await expect(shelf,"the sending thread's composer holds its file while the send waits").toHaveCount(1);await expect(page.locator(".attachment-shelf")).toContainText("notes.txt");
    await page.screenshot({animations:"disabled",path:auditDir+"turn-controls-sent-file-back-in-its-thread-dark-1280x800.png"});
    for(const route of held.splice(0))await route.fallback();
    await expect.poll(()=>fixture.threadStore.get(sending.id).turns.length,{timeout:15_000}).toBe(turnsBefore+1);
    await expect.poll(()=>fixture.threadStore.get(sending.id).turns.at(-1)?.status,{timeout:15_000}).toBe("completed");
    expect(asked.find(text=>text.includes("Use the notes."))||"","the sending thread's request carries its file").toContain("notes.txt");
    await expect(shelf).toHaveCount(0);
    await openRow("Other work","The other thread's own answer.");
    await expect(shelf).toHaveCount(0);
  }finally{for(const route of held)await route.fallback().catch(()=>{});await fixture.close()}
});

// A send that fails in a thread left is that thread's: the thread shown, with a turn of its own, stays as it was, and the draft and its
// note come back in the thread that sent it. The failure comes once the other thread is open, or while it is still opening.
for(const when of ["once the running thread is open","while the running thread opens"])test(`a send that fails in the thread left leaves the running thread shown as it was, and its draft comes back in its own thread, ${when}`,async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{names:["Codex runner","Codex failing send"]});
  try{
    codex.holdTurns=true;
    await sendTyped(page,"Count slowly in the runner.");
    await expect.poll(()=>codex.turns.length).toBe(1);const [running]=codex.turns;running.start();running.answer();
    await expect(page.getByText("Counting is done.",{exact:false})).toBeVisible({timeout:10_000});await expect(stop(page)).toBeVisible();
    await threadRow(page,"Codex failing send").locator(".thread-main").click();await expect(page.locator(".workspace-header")).toContainText("Codex failing send");
    await expect(composer(page)).toBeEnabled({timeout:10_000});
    await sendTyped(page,"This send will be refused.");
    await expect.poll(()=>codex.turns.length).toBe(2);const failing=codex.turns[1];
    await threadRow(page,"Codex runner").locator(".thread-main").click();
    if(when.startsWith("while"))failing.fail("The model is overloaded right now.");
    await expect(page.locator(".workspace-header")).toContainText("Codex runner");await expect(composer(page)).toHaveAttribute("placeholder","Queue a follow-up…",{timeout:10_000});
    if(!when.startsWith("while"))failing.fail("The model is overloaded right now.");
    await page.waitForTimeout(800);
    // The runner's turn still runs: its Stop stays, and the other thread's failure and draft are not put on the runner's composer.
    await expect(stop(page)).toBeVisible();await expect(composer(page)).toHaveAttribute("placeholder","Queue a follow-up…");
    await expect(page.getByTestId("composer-alert")).toHaveCount(0);await expect(composer(page)).toHaveValue("");
    await threadRow(page,"Codex failing send").locator(".thread-main").click();await expect(page.locator(".workspace-header")).toContainText("Codex failing send");
    await expect(composer(page)).toHaveValue("This send will be refused.");
    await expect(page.getByTestId("composer-alert")).toContainText("Not sent: The model is overloaded right now. Your draft is kept.");
    if(!when.startsWith("while"))await shoot(page,"failed-send-back-in-its-own-thread");
  }finally{await codex.close()}
});

// Codex closes a thread's session once no window follows it (thread/closed), as the agent relay's idle sweep lets a harness go: the
// window lets go of what it kept of the thread's turns (thread-turn-notes.js), and a send that failed there is still the person's
// text, given back when the thread opens again.
test("a send that fails in the thread left still comes back there after Codex closes that thread's session",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{names:["Codex runner","Codex closed send"]});
  try{
    codex.holdTurns=true;
    await sendTyped(page,"Count slowly in the runner.");
    await expect.poll(()=>codex.turns.length).toBe(1);const [running]=codex.turns;running.start();running.answer();
    await expect(page.getByText("Counting is done.",{exact:false})).toBeVisible({timeout:10_000});await expect(stop(page)).toBeVisible();
    await threadRow(page,"Codex closed send").locator(".thread-main").click();await expect(page.locator(".workspace-header")).toContainText("Codex closed send");
    await expect(composer(page)).toBeEnabled({timeout:10_000});
    await sendTyped(page,"This send will be refused.");
    await expect.poll(()=>codex.turns.length).toBe(2);const failing=codex.turns[1];
    await threadRow(page,"Codex runner").locator(".thread-main").click();
    await expect(page.locator(".workspace-header")).toContainText("Codex runner");await expect(composer(page)).toHaveAttribute("placeholder","Queue a follow-up…",{timeout:10_000});
    failing.fail("The model is overloaded right now.");await page.waitForTimeout(400);
    codex.closeThread(failing.threadId);await page.waitForTimeout(400);
    await expect(stop(page)).toBeVisible();await expect(composer(page)).toHaveValue("");await expect(page.getByTestId("composer-alert")).toHaveCount(0);
    await threadRow(page,"Codex closed send").locator(".thread-main").click();await expect(page.locator(".workspace-header")).toContainText("Codex closed send");
    await expect(composer(page)).toHaveValue("This send will be refused.");
    await expect(page.getByTestId("composer-alert")).toContainText("Not sent: The model is overloaded right now. Your draft is kept.");
    await page.screenshot({animations:"disabled",path:SHOTS+"R5-failed-send-kept-after-codex-closed-the-thread.png"});
  }finally{await codex.close()}
});

// A Stop Codex is still carrying out (it answers the interrupt once the turn has stopped) has not ended the turn: the thread left and
// opened again meanwhile still says Stopping, and the Stop pressed again there sends no second interrupt.
test("a Stop still on its way reads Stopping after the thread is left and opened again, and a second press sends no second interrupt",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{name:"Codex slow stop",settings:{keybindingRules:[{command:"threadStop",key:"Ctrl+Alt+X"}]}});
  try{
    codex.holdTurns=true;codex.interruptDelayMs=20_000;
    await sendTyped(page,"Count from one to forty, one number per line.");
    await expect.poll(()=>codex.turns.length).toBe(1);const [turn]=codex.turns;turn.start();turn.answer();
    await expect(page.getByText("Counting is done.",{exact:false})).toBeVisible({timeout:10_000});
    await stop(page).click();
    await expect(stopping(page)).toBeVisible();await expect.poll(()=>codex.interrupts.length).toBe(1);
    await newTask(page).click();await expectIdleNewTask(page);
    await threadRow(page,"Codex slow stop").locator(".thread-main").click();
    await expect(page.locator(".workspace-header")).toContainText("Codex slow stop");
    await expect(stopping(page)).toBeVisible({timeout:10_000});await expect(stopping(page)).toBeDisabled();await expect(stop(page)).toHaveCount(0);
    await shoot(page,"stopping-after-the-thread-is-opened-again");
    await page.keyboard.press("Control+Alt+X");await page.waitForTimeout(500);
    expect(codex.interrupts).toEqual([{threadId:codex.thread.id,turnId:turn.id}]);
  }finally{await codex.close()}
});

// New task pressed again on the new task keeps its unsent draft and the collaboration mode chosen for it, so the draft goes out in the
// mode the person picked.
test("New task pressed again on an unsent new-task draft keeps the collaboration mode chosen for it",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const modes=[{name:"Plan",mode:"plan",model:null,reasoning_effort:"medium"},{name:"Default",mode:"default",model:null,reasoning_effort:null}];
  const codex=await startCodex(page,{name:"Codex modes",modes});
  try{
    await newTask(page).click();await expect(page.locator(".workspace-header")).toContainText("New Trebell task");
    const picker=page.getByTestId("collaboration-mode-picker");
    await expect(picker).toBeVisible({timeout:15_000});await expect(picker).toHaveValue("default");
    await picker.selectOption("plan");await expect(picker).toHaveValue("plan");
    await typeInComposer(page,"Plan the release checklist first.");
    await newTask(page).click();
    await expect(composer(page)).toHaveValue("Plan the release checklist first.");await expect(picker).toHaveValue("plan");
    await shoot(page,"new-task-keeps-its-mode");
  }finally{await codex.close()}
});

// One queued follow-up is edited at a time: while one is being edited the others' Edit waits, so the edit typed is never replaced
// without a word, and once that edit is saved the next can be edited.
test("Edit on another queued follow-up waits while one is being edited, so the unsaved edit stays",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const codex=await startCodex(page,{name:"Queue double edit",project:true});
  try{
    codex.holdTurns=true;
    await sendTyped(page,"Main task with a queue.");await expect.poll(()=>codex.turns.length).toBe(1);codex.turns[0].answer();codex.turns[0].start();
    await expect(stop(page)).toBeVisible();
    for(const text of ["Queued alpha","Queued beta"]){await sendTyped(page,text);await expect(page.locator(".queued-message").filter({hasText:text})).toHaveCount(1)}
    const alpha=page.locator(".queued-message").filter({hasText:"Queued alpha"}),beta=page.locator(".queued-message").filter({hasText:"Queued beta"});
    await alpha.getByRole("button",{name:"Edit",exact:true}).click();await expect(composer(page)).toHaveValue("Queued alpha");
    await composer(page).click();await page.keyboard.press("End");await page.keyboard.type(" with an important change",{delay:8});
    const betaEdit=beta.getByRole("button",{name:"Edit",exact:true});
    await expect(betaEdit).toBeDisabled();await expect(betaEdit).toHaveAttribute("title","Save the follow-up you are editing, or press Escape, first");
    await shoot(page,"queued-edit-waits-for-the-open-edit");
    await expect(composer(page)).toHaveValue("Queued alpha with an important change");
    await composer(page).click();await page.keyboard.press("End");await page.keyboard.press("Enter");
    await expect(alpha).toContainText("Queued alpha with an important change");
    await expect(betaEdit).toBeEnabled();await betaEdit.click();await expect(composer(page)).toHaveValue("Queued beta");
  }finally{await codex.close()}
});

// A double click on a queued follow-up's Remove takes out that follow-up only. The first click removes it once the queue has answered,
// and the next follow-up comes up in its place under the pointer, where the second click lands: the rest of the press does nothing,
// as on a thread's menu. In Codex's queue (a General chat's) and Trebell's own (a project thread's) alike. Enter held on Remove
// takes out one follow-up: in Codex's queue the row waits for Codex's answer with the keyboard on it, and the key's repeats send no
// second thread/queue/delete for it; in Trebell's the row goes at once and the keyboard leaves with it. A click of its own still
// removes.
for(const kind of ["Codex","Trebell"]){
  test(`a double click or Enter held on Remove in ${kind}'s queue removes only the follow-up it was aimed at`,async({page})=>{
    test.setTimeout(90_000);
    await page.setViewportSize({width:1280,height:1100});
    const codex=await startCodex(page,{name:"Queue double remove",project:kind==="Trebell"});
    try{
      codex.holdTurns=true;
      await sendTyped(page,"Main task with a queue.");await expect.poll(()=>codex.turns.length).toBe(1);codex.turns[0].answer();codex.turns[0].start();
      await expect(stop(page)).toBeVisible();
      for(const text of ["Queued alpha","Queued beta","Queued gamma","Queued delta"]){await sendTyped(page,text);await expect(page.locator(".queued-message").filter({hasText:text})).toHaveCount(1)}
      const remove=text=>page.locator(".queued-message").filter({hasText:text}).getByRole("button",{name:"Remove",exact:true});
      const box=await remove("Queued alpha").boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
      const under=()=>page.evaluate(([x,y])=>{const node=document.elementFromPoint(x,y);return node?.closest(".queued-message")?.querySelector("p")?.textContent+" · "+node?.textContent},[x,y]);
      // The double click's first click, and its second once alpha has gone and beta's Remove is under the pointer.
      await page.mouse.move(x,y);await page.mouse.down();await page.mouse.up();
      await expect(page.locator(".queued-message p")).toHaveText(["Queued beta","Queued gamma","Queued delta"]);
      expect(await under()).toBe("Queued beta · Remove");
      await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});
      await page.waitForTimeout(600);
      await expect(page.locator(".queued-message p")).toHaveText(["Queued beta","Queued gamma","Queued delta"]);
      if(kind==="Codex")expect(codex.calls.filter(method=>method==="thread/queue/delete")).toHaveLength(1);
      await remove("Queued beta").focus();await page.keyboard.down("Enter");
      for(let repeat=0;repeat<6;repeat++)await page.keyboard.down("Enter");
      await page.keyboard.up("Enter");
      await expect(page.locator(".queued-message p")).toHaveText(["Queued gamma","Queued delta"]);
      if(kind==="Codex")expect(codex.calls.filter(method=>method==="thread/queue/delete")).toHaveLength(2);
      await shoot(page,"queue-double-remove-"+kind.toLowerCase());
      await remove("Queued gamma").click();
      await expect(page.locator(".queued-message p")).toHaveText(["Queued delta"]);
    }finally{await codex.close()}
  });
}

// On a harness that cannot steer a running turn, Send now on a queued follow-up is off while the turn runs, and its title says why
// and what the person can do, as it does for the follow-up being edited; the shortcut that sends the oldest follow-up now says so
// too, and sends nothing. The title promises nothing about the queue, which may wait after the turn (a Stop holds it, a follow-up
// to retry does not go by itself): only that Send now works once the turn ends.
for(const kind of ["Trebell","Codex"]){
  test(`Send now on a follow-up in ${kind}'s queue says why it is off while a turn runs on a harness that cannot steer`,async({page})=>{
    test.setTimeout(60_000);
    await page.setViewportSize({width:1280,height:800});
    const codex=await startCodex(page,{name:"No steering",project:kind==="Trebell",capabilities:{...sharedRuntimeCapabilities("codex"),steering:false}});
    try{
      codex.holdTurns=true;
      await sendTyped(page,"Main task.");await expect.poll(()=>codex.turns.length).toBe(1);codex.turns[0].answer();codex.turns[0].start();
      await expect(stop(page)).toBeVisible();
      await sendTyped(page,"Follow-up without steering");
      const sendNow=page.locator(".queued-message").filter({hasText:"Follow-up without steering"}).getByRole("button",{name:"Send now"});
      await expect(sendNow).toBeDisabled();
      await expect(sendNow).toHaveAttribute("title","Codex cannot steer a running turn; Send now works once the turn ends");
      await shoot(page,"send-now-without-steering-"+kind.toLowerCase());
      await composer(page).click();await page.keyboard.press("Control+Shift+Enter");
      await expect(page.getByTestId("app-action-error")).toHaveText("Could not send queued follow-up: Codex cannot steer a running turn; Send now works once the turn ends");
      await expect(page.locator(".queued-message p")).toHaveText(["Follow-up without steering"]);
      expect(codex.calls.filter(method=>["turn/steer","thread/queue/start","thread/queue/delete"].includes(method))).toEqual([]);expect(codex.turns).toHaveLength(1);
    }finally{await codex.close()}
  });
}
