import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";
import { auditDir,gate,startStreamingFixture } from "./native-stream-fixture.js";
import { replyItem,routeRelayApp,startRelayHarness } from "./relay-history-harness.js";

// The parts of the app whose code loads after the first paint (lazy chunks), when that code cannot load: the UI was rebuilt or
// updated under an open page, or the link to a remote Trebell server dropped. The browser keeps such a module as failed, so the
// part cannot come until the page reloads; it must say so in its place and leave the rest of the app on screen.

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// A Codex app-server stand-in behind the real Codex relay, as guardian.spec.js builds it: one thread; send() pushes a message from
// the harness to the page, and messages holds what the page sent it (its answers to the harness's requests among them). recovery is
// what /api/recovery answers (the turns a restart interrupted), and answer(message) can answer a request of the page's itself.
async function codexFixture(page,{recovery={enabled:false,items:[]},answer=()=>undefined}={}){
  const thread={id:"lazy-chunk-fixture",name:"Lazy chunk fixture",preview:"Lazy chunks",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  let socket=null;const messages=[];
  const upstreamHttp=createServer(),upstreamWss=new WebSocketServer({noServer:true}),sockets=new Set();
  upstreamHttp.on("upgrade",(req,raw,head)=>upstreamWss.handleUpgrade(req,raw,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);socket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));messages.push(message);if(message.id==null||!message.method)return;let result={};const answered=answer(message);
      if(answered!==undefined)result=answered;
      else if(message.method==="initialize")result={userAgent:"lazy-chunk-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:process.platform,version:"lazy-chunk-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  const recoveryPosts=[];
  await page.route(/\/api\/recovery$/,route=>{
    if(route.request().method()!=="POST")return json(route,recovery);
    recoveryPosts.push(route.request().postDataJSON());return json(route,{ok:true});
  });
  return {
    thread,messages,recoveryPosts,send:message=>socket.send(JSON.stringify(message)),
    async close(){relay.close();for(const item of sockets)try{item.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])},
  };
}
// From here on every script the page has not loaded yet fails to load, as after the UI was rebuilt under the open page.
async function refuseScriptsFromNow(page){
  const refused=[];
  await page.route(/\/assets\/[^/?]+\.js(?:\?.*)?$/,route=>{refused.push(new URL(route.request().url()).pathname.split("/").pop());return route.abort("failed")});
  return refused;
}
const appStays=async page=>{
  await expect(page.locator(".sidebar"),"the sidebar").toBeVisible();
  await expect(page.getByTestId("composer"),"the composer").toBeVisible();
};
// Opens the fixture's thread from the sidebar and waits until it shows: its General chat welcome. The new-task screen before the
// click has a welcome of its own, so waiting for any welcome let the harness's messages come while the thread was still opening.
// Those are handled as the thread shows, and steps of a turn that is not running then stay on that turn's own card only, so the
// denial's step was not on the live card when it came during the open.
async function openFixtureThread(page){
  await page.goto("/");await page.getByRole("button",{name:/Lazy chunk fixture/}).click();
  await expect(page.getByRole("heading",{name:"What do you want to think through?"})).toBeVisible();
  await expect(page.getByTestId("composer")).toHaveAttribute("placeholder","Ask Trebell Code anything…");
}

// A harness waits on its approval, so the approval card is part of the app's first script: it shows the moment the request comes
// and is answered with no script left to load.
test("an approval shows the moment it is asked and is answered with no script left to load",async({page})=>{
  test.setTimeout(45_000);
  const fixture=await codexFixture(page);
  try{
    await openFixtureThread(page);
    const refused=await refuseScriptsFromNow(page);
    fixture.send({id:"approval-now",method:"item/commandExecution/requestApproval",params:{threadId:fixture.thread.id,turnId:"turn-approval",itemId:"cmd-approval",command:["echo","approval"],reason:"Approve this fixture command"}});
    const card=page.locator(".conversation-column .approval-card").filter({hasText:"Approve this fixture command"});
    await expect(card).toBeVisible({timeout:1500});
    await expect(card.getByTestId("approval-command")).toHaveText("echo approval");
    await card.getByRole("button",{name:"Allow once",exact:true}).click();
    await expect.poll(()=>fixture.messages.find(message=>message.id==="approval-now"&&!message.method)?.result??null,{message:"the answer the harness got"}).toEqual({decision:"accept"});
    await expect(card).toHaveCount(0);
    await appStays(page);
    console.log("scripts refused meanwhile:",JSON.stringify(refused));
  }finally{await fixture.close()}
});

// An auto-review denial's card loads with the first denial. When its code cannot load, the place of the card says so, with Reload,
// and the rest of the app stays.
test("a denial whose card cannot load says so in its place, and the rest of the app stays",async({page})=>{
  test.setTimeout(45_000);
  const fixture=await codexFixture(page);
  try{
    await openFixtureThread(page);
    await refuseScriptsFromNow(page);
    const startedAt=Date.now(),action={type:"command",source:"unifiedExec",command:"rm generated.tmp",cwd:process.cwd()};
    fixture.send({method:"item/autoApprovalReview/started",params:{threadId:fixture.thread.id,turnId:"turn-1",startedAtMs:startedAt,reviewId:"review-1",targetItemId:"cmd-1",review:{status:"inProgress",riskLevel:null,userAuthorization:null,rationale:null},action}});
    fixture.send({method:"item/autoApprovalReview/completed",params:{threadId:fixture.thread.id,turnId:"turn-1",startedAtMs:startedAt,completedAtMs:startedAt+125,reviewId:"review-1",targetItemId:"cmd-1",decisionSource:"agent",review:{status:"denied",riskLevel:"high",userAuthorization:"low",rationale:"Deleting this file needs explicit user approval."},action}});
    const failed=page.locator(".conversation-column .lazy-slot-error");
    await expect(failed).toContainText("This part of Trebell could not be shown:");
    await expect(failed).toHaveAttribute("role","alert");
    await expect(failed.getByRole("button",{name:"Reload",exact:true})).toBeVisible();
    await appStays(page);
    await expect(page.getByText(/Auto review · rm generated\.tmp/).first()).toBeVisible();
    await page.screenshot({animations:"disabled",path:auditDir+"lazy-chunk-denial-card-cannot-load.png"});
  }finally{await fixture.close()}
});

// The Runtime tab's background-processes list loads with the tab. When its code cannot load, the list's place says so and the
// rest of the tab (the harness grid, the trace, the latest activity) and of the app stays.
test("the Runtime tab whose background-processes list cannot load says so there, and the tab and the app stay",async({page})=>{
  test.setTimeout(60_000);
  await page.route(/\/assets\/AgentBackgroundTerminals-[^/]*\.js$/,route=>route.abort("failed"));
  const fixture=await startStreamingFixture(page);
  try{
    await fixture.open("Native streaming");
    await page.getByTestId("right-panel-toggle").click();
    const panel=page.getByTestId("right-panel");
    await panel.getByRole("button",{name:"Runtime",exact:true}).click();
    const failed=panel.locator(".lazy-slot-error");
    await expect(failed).toContainText("This part of Trebell could not be shown:");
    await expect(failed.getByRole("button",{name:"Reload",exact:true})).toBeVisible();
    await expect(panel.getByText("Agent harness",{exact:true})).toBeVisible();
    await expect(panel.getByText("Latest activity",{exact:true})).toBeVisible();
    await expect(panel.getByTestId("runtime-capabilities")).toBeVisible();
    await appStays(page);
  }finally{await fixture.close()}
});

// A page loads with its first visit. When its code cannot load, the page says so and the rest of the app (the sidebar and the way
// back to the chat) stays.
test("a page whose code cannot load says so, and the way back to the chat stays",async({page,request})=>{
  test.setTimeout(45_000);
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",modelProvider:"openai"}});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.route(/\/assets\/ProjectsPage-[^/]*\.js$/,route=>route.abort("failed"));
  const nav=label=>page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:label,exact:true});
  await nav("Projects").click();
  const failed=page.locator(".secondary-page .lazy-slot-error");
  await expect(failed).toContainText("This part of Trebell could not be shown:");
  await expect(page.getByRole("heading",{name:"Projects",level:1})).toBeVisible();
  await nav("New task").click();
  await expect(page.getByTestId("composer")).toBeVisible();
});

// Trebell's own tool catalog loads at idle after the first paint (B11). A new task sent before it has come waits for it and starts
// once it is there.
test("a new task sent before the tool catalog has loaded waits for it and starts",async({page})=>{
  test.setTimeout(60_000);
  const held=[];
  await page.route(/\/assets\/shared-tool-catalog-[^/]*\.js$/,route=>{held.push(route)});
  const fixture=await startStreamingFixture(page,{providerTurn:async request=>({id:"catalog-late",provider:request.provider,model:request.model,text:"Started once the catalog came.",toolCalls:[],finishReason:"stop",usage:{}})});
  try{
    await expect.poll(()=>held.length,{message:"the catalog asked for at idle"}).toBe(1);
    const before=fixture.threadStore.list("native").length;
    await fixture.send("Start while the catalog is still on its way");
    // The send is under way and waits for the catalog: no thread starts until it comes.
    await expect(page.getByTestId("composer")).toHaveValue("");
    await page.waitForTimeout(500);expect(fixture.threadStore.list("native")).toHaveLength(before);
    for(const route of held.splice(0))await route.continue();
    await expect(page.locator(".user-row").filter({hasText:"Start while the catalog is still on its way"})).toBeVisible({timeout:10_000});
    await expect(page.getByText("Started once the catalog came.",{exact:true})).toBeVisible({timeout:10_000});
    expect(fixture.threadStore.list("native")).toHaveLength(before+1);
    await appStays(page);
  }finally{for(const route of held)await route.continue().catch(()=>{});await fixture.close()}
});

// When the catalog cannot load, a new task fails and says so instead of waiting for it, and what was typed is not lost.
test("a new task whose tool catalog cannot load says so instead of waiting, and keeps the message",async({page})=>{
  test.setTimeout(60_000);
  let refused=0;
  await page.route(/\/assets\/shared-tool-catalog-[^/]*\.js$/,route=>{refused++;return route.abort("failed")});
  const fixture=await startStreamingFixture(page,{providerTurn:async request=>({id:"catalog-refused",provider:request.provider,model:request.model,text:"This should not start.",toolCalls:[],finishReason:"stop",usage:{}})});
  try{
    await expect.poll(()=>refused,{message:"the catalog asked for at idle"}).toBeGreaterThan(0);
    const before=fixture.threadStore.list("native").length;
    await fixture.send("Start when the catalog cannot load");
    await expect(page.getByRole("alert").filter({hasText:"Not sent"})).toHaveText("Not sent: Part of Trebell could not load. Reload Trebell to get it back. Your draft is kept.",{timeout:5000});
    await expect(page.getByTestId("composer")).toHaveValue("Start when the catalog cannot load");
    expect(fixture.threadStore.list("native")).toHaveLength(before);
    await appStays(page);
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({animations:"disabled",path:auditDir+"tool-catalog-cannot-load-dark-1280x800.png"});
  }finally{await fixture.close()}
});

// The catalog comes before anything is set up for a new task, so a "New worktree" send that cannot load it makes no Git worktree
// and branch at each try, and the view stays on the project instead of moving into a worktree nothing runs in.
test("a new task in a new worktree whose tool catalog cannot load makes no worktree, at each try",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  let refused=0;
  await page.route(/\/assets\/shared-tool-catalog-[^/]*\.js$/,route=>{refused++;return route.abort("failed")});
  const fixture=await startStreamingFixture(page,{providerTurn:async request=>({id:"catalog-refused",provider:request.provider,model:request.model,text:"This should not start.",toolCalls:[],finishReason:"stop",usage:{}})});
  const actions=[];
  await page.route(/\/api\/git\/action$/,async route=>{const body=route.request().postDataJSON()||{};actions.push(body);await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,result:{worktree:body.path}})})});
  try{
    await expect.poll(()=>refused,{message:"the catalog asked for at idle"}).toBeGreaterThan(0);
    await page.locator("select.workspace-mode").selectOption("worktree");
    const before=fixture.threadStore.list("native").length,crumb=await page.locator(".workspace-header").innerText();
    for(let attempt=0;attempt<2;attempt++){
      await fixture.send("Start in a new worktree");
      await expect(page.getByRole("alert").filter({hasText:"Not sent"})).toHaveText("Not sent: Part of Trebell could not load. Reload Trebell to get it back. Your draft is kept.",{timeout:10_000});
      await expect(page.getByTestId("composer")).toHaveValue("Start in a new worktree");
    }
    expect(actions.filter(body=>body.action==="worktree-create"),"no worktree is made for a send that cannot start").toEqual([]);
    expect(fixture.threadStore.list("native")).toHaveLength(before);
    expect(await page.locator(".workspace-header").innerText(),"the view stays on the project").toBe(crumb);
    await expect(page.getByText("Worktree created",{exact:false})).toHaveCount(0);
    await appStays(page);
  }finally{await fixture.close()}
});

// What the app does around a turn beyond showing it (turn-support.js: a send's repository context and new worktree, a send that is
// a slash command, the agent's calls to Trebell's own tools, a completed turn's verification, the turns a restart interrupted) loads
// at idle after the first paint (B11). A send made before then waits for it and starts with its repository context once it has come:
// the server's packet (here a seed naming the fixture's session.js) shows in the activity and reaches the model with the message.
test("a send made before the turn support has loaded waits for it and starts with its context",async({page})=>{
  test.setTimeout(60_000);
  const held=[],userTexts=[];
  await page.route(/\/assets\/turn-support-[^/]*\.js$/,route=>{held.push(route)});
  const fixture=await startStreamingFixture(page,{providerTurn:async request=>{
    userTexts.push(JSON.stringify(request.messages?.find(item=>item.role==="user")?.content||""));
    return {id:"support-late",provider:request.provider,model:request.model,text:"Started once the turn support came.",toolCalls:[],finishReason:"stop",usage:{}};
  }});
  const packets=[];
  await page.route(/\/api\/context\/packet$/,route=>{packets.push(route.request().method());return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
    id:"held-context",root:fixture.repo,task:"Start while the turn support is still on its way",generatedAt:Date.now(),tokenEstimate:120,maxTokens:2800,instructionInjection:"",untrustedInjection:"",injection:"",
    items:[{path:"session.js",score:90,reasons:["defines task-related symbol: SessionManager"],symbols:[{name:"SessionManager",kind:"class",line:1}],tokenEstimate:40}],
    budget:{mode:"focused",pressure:"normal",maxTokens:2800,maxFiles:12},stats:{},
  })})});
  try{
    await expect.poll(()=>held.length,{message:"the turn support asked for at idle"}).toBe(1);
    await fixture.open("Native streaming");
    await fixture.send("Start while the turn support is still on its way");
    // The message shows at once, and the turn waits for the turn support: no context is asked for and no model is called until it comes.
    await expect(page.locator(".user-row").filter({hasText:"Start while the turn support is still on its way"})).toBeVisible();
    await page.waitForTimeout(500);expect(packets).toEqual([]);expect(fixture.requests).toHaveLength(0);
    for(const route of held.splice(0))await route.continue();
    await expect(page.getByText("Started once the turn support came.",{exact:true})).toBeVisible({timeout:10_000});
    expect(packets).toEqual(["POST"]);expect(fixture.requests).toHaveLength(1);
    await expect(page.locator(".tool-event").filter({hasText:"Trebell context ·"})).toContainText(/Trebell context · 1 file · ~\d+ tokens/);
    expect(userTexts,"the turn reached the model once").toHaveLength(1);
    expect(userTexts[0],"the turn carried the repository seed").toContain("Trebell repository seed");
    expect(userTexts[0]).toContain("session.js — defines task-related symbol: SessionManager | symbols: class SessionManager");
    await appStays(page);
  }finally{for(const route of held)await route.continue().catch(()=>{});await fixture.close()}
});

// A slash command sent before the turn support has come waits for it too, and runs once it is in: /plan fills the composer with the
// plan prompt to send, and nothing goes to the model. Meanwhile the composer says Sending…, the command gone from it as the send
// started, so what is typed then is not dropped.
test("a slash command sent before the turn support has loaded waits for it and runs",async({page})=>{
  test.setTimeout(60_000);
  const held=[];
  await page.route(/\/assets\/turn-support-[^/]*\.js$/,route=>{held.push(route)});
  const fixture=await startStreamingFixture(page,{providerTurn:async request=>({id:"slash-late",provider:request.provider,model:request.model,text:"This should not start.",toolCalls:[],finishReason:"stop",usage:{}})});
  try{
    await expect.poll(()=>held.length,{message:"the turn support asked for at idle"}).toBe(1);
    await fixture.open("Native streaming");
    await fixture.send("/plan the release");
    await page.waitForTimeout(500);
    await expect(page.getByTestId("composer")).toHaveAttribute("placeholder",/^Sending/);await expect(page.getByTestId("composer")).toHaveValue("");
    for(const route of held.splice(0))await route.continue();
    await expect(page.getByTestId("composer")).toHaveValue("Create a clear execution plan, then carry it out. the release",{timeout:10_000});
    await expect(page.getByRole("alert").filter({hasText:"Not sent"})).toHaveCount(0);
    expect(fixture.requests,"nothing went to the model").toHaveLength(0);
    await appStays(page);
  }finally{for(const route of held)await route.continue().catch(()=>{});await fixture.close()}
});

// When the turn support cannot load, a send in the open thread still starts, without the repository context, and its activity says
// why, as for a context the server could not make.
test("a send whose turn support cannot load starts without repository context and says why",async({page})=>{
  test.setTimeout(60_000);
  let refused=0;
  await page.route(/\/assets\/turn-support-[^/]*\.js$/,route=>{refused++;return route.abort("failed")});
  const fixture=await startStreamingFixture(page),shown=gate(),finish=gate();
  try{
    await expect.poll(()=>refused,{message:"the turn support asked for at idle"}).toBeGreaterThan(0);
    const head="Answering without the repository context. ";
    fixture.script.push(async(request,hook)=>{hook({type:"text",delta:head});shown.open();await finish.promise;return {id:"support-refused",provider:request.provider,model:request.model,text:head+"Done.",toolCalls:[],finishReason:"stop",usage:{}}});
    await fixture.open("Native streaming");await fixture.send("Answer without the repository context");await shown.promise;
    await expect(page.locator(".tool-event").filter({hasText:"Trebell repository context unavailable"})).toContainText("Trebell repository context unavailable: Part of Trebell could not load. Reload Trebell to get it back.");
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({animations:"disabled",path:auditDir+"turn-support-cannot-load-dark-1280x800.png"});
    finish.open();
    await expect(page.locator(".history-assistant .assistant-message-text")).toContainText("Done.",{timeout:15_000});
    await appStays(page);
  }finally{finish.open();await fixture.close()}
});

// A New worktree send cannot make its worktree without the turn support: it fails and says so before anything is set up, and what
// was typed is not lost.
test("a new task in a new worktree whose turn support cannot load makes no worktree and keeps the message",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  let refused=0;
  await page.route(/\/assets\/turn-support-[^/]*\.js$/,route=>{refused++;return route.abort("failed")});
  const fixture=await startStreamingFixture(page,{providerTurn:async request=>({id:"support-refused",provider:request.provider,model:request.model,text:"This should not start.",toolCalls:[],finishReason:"stop",usage:{}})});
  const actions=[];
  await page.route(/\/api\/git\/action$/,async route=>{const body=route.request().postDataJSON()||{};actions.push(body);await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,result:{worktree:body.path}})})});
  try{
    await expect.poll(()=>refused,{message:"the turn support asked for at idle"}).toBeGreaterThan(0);
    await page.locator("select.workspace-mode").selectOption("worktree");
    const before=fixture.threadStore.list("native").length;
    await fixture.send("Start in a new worktree");
    await expect(page.getByRole("alert").filter({hasText:"Not sent"})).toHaveText("Not sent: Part of Trebell could not load. Reload Trebell to get it back. Your draft is kept.",{timeout:10_000});
    await expect(page.getByTestId("composer")).toHaveValue("Start in a new worktree");
    expect(actions.filter(body=>body.action==="worktree-create"),"no worktree is made for a send that cannot start").toEqual([]);
    expect(fixture.threadStore.list("native")).toHaveLength(before);
    await appStays(page);
  }finally{await fixture.close()}
});

// A harness waits on the answer to a call of Trebell's own tools: with the turn support unable to load, it is answered at once
// with the reason, as a tool that fails is.
test("a tool call whose turn support cannot load is answered with the reason, and the app stays",async({page})=>{
  test.setTimeout(45_000);
  let refused=0;
  await page.route(/\/assets\/turn-support-[^/]*\.js$/,route=>{refused++;return route.abort("failed")});
  const fixture=await codexFixture(page);
  try{
    await openFixtureThread(page);
    await expect.poll(()=>refused,{message:"the turn support asked for at idle"}).toBeGreaterThan(0);
    fixture.send({id:"tool-call-now",method:"item/tool/call",params:{threadId:fixture.thread.id,turnId:"turn-tool",callId:"call-tool",namespace:"trebell_repo",tool:"search_symbols",arguments:{query:"relay"}}});
    await expect.poll(()=>fixture.messages.find(message=>message.id==="tool-call-now"&&!message.method)?.result??null,{message:"the answer the harness got"}).toEqual({contentItems:[{type:"inputText",text:"Part of Trebell could not load. Reload Trebell to get it back."}],success:false});
    await appStays(page);
  }finally{await fixture.close()}
});

// A call that comes before the turn support has loaded waits for it, and is answered once it is in (here the answer for a tool no one
// registered, which only the turn support gives).
test("a tool call made before the turn support has loaded waits for it and is answered",async({page})=>{
  test.setTimeout(45_000);
  const held=[];
  await page.route(/\/assets\/turn-support-[^/]*\.js$/,route=>{held.push(route)});
  const fixture=await codexFixture(page);
  const answer=()=>fixture.messages.find(message=>message.id==="tool-call-held"&&!message.method)?.result??null;
  try{
    await openFixtureThread(page);
    await expect.poll(()=>held.length,{message:"the turn support asked for at idle"}).toBe(1);
    fixture.send({id:"tool-call-held",method:"item/tool/call",params:{threadId:fixture.thread.id,turnId:"turn-tool",callId:"call-held",namespace:"fixture_tools",tool:"echo",arguments:{}}});
    await page.waitForTimeout(500);expect(answer(),"no answer before the turn support came").toBeNull();
    for(const route of held.splice(0))await route.continue();
    await expect.poll(answer,{message:"the answer the harness got"}).toEqual({contentItems:[{type:"inputText",text:"No client-defined dynamic tool is registered for fixture_tools/echo"}],success:false});
    await appStays(page);
  }finally{for(const route of held)await route.continue().catch(()=>{});await fixture.close()}
});

// A completed turn's verification is planned by the turn support. With it unable to load, the open thread's activity says the plan
// could not be made, and why.
test("a completed turn whose turn support cannot load says its verification could not be planned",async({page})=>{
  test.setTimeout(45_000);
  let refused=0;
  await page.route(/\/assets\/turn-support-[^/]*\.js$/,route=>{refused++;return route.abort("failed")});
  const fixture=await codexFixture(page);
  try{
    await openFixtureThread(page);
    await expect.poll(()=>refused,{message:"the turn support asked for at idle"}).toBeGreaterThan(0);
    fixture.send({method:"turn/completed",params:{threadId:fixture.thread.id,turn:{id:"turn-unplanned",status:"completed",completedAt:Date.now()/1000}}});
    await expect(page.locator(".tool-event").filter({hasText:"Could not plan turn verification"})).toContainText("Could not plan turn verification: Part of Trebell could not load. Reload Trebell to get it back.");
    await appStays(page);
  }finally{await fixture.close()}
});

// What a person does to threads (thread-actions.js: pin, snooze, settle, archive, fork, delete, Undo, a move up or down) loads at
// idle after the first paint too. A Pin made before then waits for it and pins the thread once it has come; with it unable to load,
// the Pin says so in the sidebar and the thread stays where it was.
const pinnedThreads=page=>page.locator(".thread-sections section").evaluateAll(sections=>{
  const pinned=sections.find(section=>section.querySelector("h4 .thread-group-name")?.textContent==="Pinned");
  return pinned?[...pinned.querySelectorAll(".thread-main")].map(node=>node.title):[];
});
async function pinFromMenu(page,name){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});
  await row.hover();await row.locator(".thread-menu summary").click();
  await row.getByRole("button",{name:"Pin",exact:true}).click();
}
test("a Pin made before the thread actions have loaded waits for them and pins the thread",async({page})=>{
  test.setTimeout(60_000);
  const held=[];
  await page.route(/\/assets\/thread-actions-[^/]*\.js$/,route=>{held.push(route)});
  const fixture=await startStreamingFixture(page);
  try{
    await expect.poll(()=>held.length,{message:"the thread actions asked for at idle"}).toBe(1);
    await pinFromMenu(page,"Native streaming");
    await page.waitForTimeout(500);expect(await pinnedThreads(page)).toEqual([]);
    for(const route of held.splice(0))await route.continue();
    await expect.poll(()=>pinnedThreads(page)).toEqual(["Native streaming"]);
    await expect(page.getByTestId("thread-undo-toast").locator("span").first()).toHaveText("Thread pinned");
    await appStays(page);
  }finally{for(const route of held)await route.continue().catch(()=>{});await fixture.close()}
});
test("a Pin whose thread actions cannot load says so in the sidebar, and the thread stays where it was",async({page})=>{
  test.setTimeout(60_000);
  let refused=0;
  await page.route(/\/assets\/thread-actions-[^/]*\.js$/,route=>{refused++;return route.abort("failed")});
  const fixture=await startStreamingFixture(page);
  try{
    await expect.poll(()=>refused,{message:"the thread actions asked for at idle"}).toBeGreaterThan(0);
    await pinFromMenu(page,"Native streaming");
    await expect(page.locator(".sidebar .sidebar-action-error")).toHaveText("Part of Trebell could not load. Reload Trebell to get it back.");
    expect(await pinnedThreads(page)).toEqual([]);
    await expect(page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native streaming"]')})).toBeVisible();
    await appStays(page);
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({animations:"disabled",path:auditDir+"thread-actions-cannot-load-dark-1280x800.png"});
  }finally{await fixture.close()}
});
// An action made before the thread actions have come reads the thread open when it runs: the open thread pinned before the person
// opened another is pinned once they come, and the thread opened meanwhile stays the open one, marked in the sidebar and named in
// the header.
test("a Pin made before the thread actions have loaded leaves open the thread opened meanwhile",async({page})=>{
  test.setTimeout(60_000);
  const held=[];
  await page.route(/\/assets\/thread-actions-[^/]*\.js$/,route=>{held.push(route)});
  const fixture=await startStreamingFixture(page,{threads:[{name:"Native streaming",preview:"Live reply"},{name:"Opened meanwhile",preview:"Second thread"}]});
  try{
    await expect.poll(()=>held.length,{message:"the thread actions asked for at idle"}).toBe(1);
    await fixture.open("Native streaming");
    await pinFromMenu(page,"Native streaming");
    await fixture.open("Opened meanwhile");
    await expect(page.locator(".thread-title-button strong")).toHaveText("Opened meanwhile");
    for(const route of held.splice(0))await route.continue();
    await expect.poll(()=>pinnedThreads(page)).toEqual(["Native streaming"]);
    await expect(page.getByTestId("thread-undo-toast").locator("span").first()).toHaveText("Thread pinned");
    await expect(page.locator(".thread-row.active .thread-main")).toHaveAttribute("title","Opened meanwhile");
    await expect(page.locator(".thread-title-button strong")).toHaveText("Opened meanwhile");
    await appStays(page);
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({animations:"disabled",path:auditDir+"thread-actions-pin-before-load-other-open-dark-1280x800.png"});
  }finally{for(const route of held)await route.continue().catch(()=>{});await fixture.close()}
});

// A send that starts with "/" may be a command, which the turn support runs (runSlashCommand). With it unable to load, the send
// cannot tell a command from a message, so it is not made: it says why, and what was typed stays in the composer.
test("a slash command whose turn support cannot load is not sent and keeps the draft",async({page})=>{
  test.setTimeout(60_000);
  let refused=0;
  await page.route(/\/assets\/turn-support-[^/]*\.js$/,route=>{refused++;return route.abort("failed")});
  const fixture=await startStreamingFixture(page,{providerTurn:async request=>({id:"slash-refused",provider:request.provider,model:request.model,text:"This should not start.",toolCalls:[],finishReason:"stop",usage:{}})});
  try{
    await expect.poll(()=>refused,{message:"the turn support asked for at idle"}).toBeGreaterThan(0);
    await fixture.open("Native streaming");
    await fixture.send("/plan the release");
    await expect(page.getByRole("alert").filter({hasText:"Not sent"})).toHaveText("Not sent: Part of Trebell could not load. Reload Trebell to get it back. Your draft is kept.",{timeout:10_000});
    await expect(page.getByTestId("composer")).toHaveValue("/plan the release");
    expect(fixture.requests,"nothing went to the model").toHaveLength(0);
    await appStays(page);
  }finally{await fixture.close()}
});

// The Codex turns a restart interrupted are continued once the app connects (continueInterruptedTurns), by the turn support, which
// loads then when the server names some: a turn still running goes on, one that ended meanwhile is cleared, and one that may already
// have done what it was doing is left to the person, whom the app tells.
test("the Codex turns a restart interrupted are continued once the app connects, and one that may have acted is left to the person",async({page})=>{
  test.setTimeout(45_000);
  const turns={"interrupted-thread":{id:"turn-interrupted",status:"inProgress"},"finished-thread":{id:"turn-finished",status:"completed"}};
  const fixture=await codexFixture(page,{
    recovery:{enabled:true,items:[{threadId:"interrupted-thread",turnId:"turn-interrupted"},{threadId:"finished-thread",turnId:"turn-finished"}],blocked:[{message:"An interrupted browser click may already have happened. Inspect the page before continuing."}]},
    answer:message=>message.method==="thread/turns/list"&&turns[message.params?.threadId]?{data:[turns[message.params.threadId]],nextCursor:null}:undefined,
  });
  try{
    await page.goto("/");
    await expect(page.getByTestId("app-action-error")).toHaveText("Restart recovery needs inspection: An interrupted browser click may already have happened. Inspect the page before continuing.");
    await expect.poll(()=>fixture.messages.filter(message=>message.method==="turn/start").map(message=>[message.params?.threadId,message.params?.turnTrigger]),{message:"the turns the app continued"}).toEqual([["interrupted-thread","trebell-restart-continuation"]]);
    await expect.poll(()=>fixture.recoveryPosts,{message:"the recoveries the app cleared"}).toEqual([{threadId:"finished-thread",action:"clear"}]);
    await expect(page.getByRole("button",{name:/Lazy chunk fixture/})).toBeVisible();
    await appStays(page);
  }finally{await fixture.close()}
});

// With the turn support unable to load, a connect that finds turns a restart interrupted says it could not check them, continues
// and clears none of them (the server keeps them for the next start), and the threads still load.
test("restart recovery whose turn support cannot load says so, and the threads still load",async({page})=>{
  test.setTimeout(45_000);
  await page.route(/\/assets\/turn-support-[^/]*\.js$/,route=>route.abort("failed"));
  const fixture=await codexFixture(page,{recovery:{enabled:true,items:[{threadId:"interrupted-thread",turnId:"turn-interrupted"}]}});
  try{
    await page.goto("/");
    await expect(page.getByTestId("app-action-error")).toHaveText("Could not check restart recovery: Part of Trebell could not load. Reload Trebell to get it back.");
    await expect(page.getByRole("button",{name:/Lazy chunk fixture/})).toBeVisible();
    expect(fixture.messages.filter(message=>message.method==="turn/start"),"no turn continued").toEqual([]);
    expect(fixture.recoveryPosts,"no recovery cleared or marked failed").toEqual([]);
    await appStays(page);
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({animations:"disabled",path:auditDir+"restart-recovery-cannot-load-dark-1280x800.png"});
  }finally{await fixture.close()}
});

// A turn a restart interrupted that may already have done what it was doing is only told to the person, which needs none of the turn
// support: a connect that finds only such turns says so, and the threads load, while the turn support is still on its way (its script
// is held for the whole test).
test("restart recovery that only needs inspection says so and the threads load while the turn support is on its way",async({page})=>{
  test.setTimeout(45_000);
  const held=[];
  await page.route(/\/assets\/turn-support-[^/]*\.js$/,route=>{held.push(route)});
  const fixture=await codexFixture(page,{recovery:{enabled:true,items:[],blocked:[{message:"An interrupted browser click may already have happened. Inspect the page before continuing."}]}});
  try{
    await page.goto("/");
    await expect(page.getByTestId("app-action-error")).toHaveText("Restart recovery needs inspection: An interrupted browser click may already have happened. Inspect the page before continuing.");
    await expect(page.getByRole("button",{name:/Lazy chunk fixture/})).toBeVisible();
    expect(fixture.recoveryPosts,"nothing cleared or marked failed").toEqual([]);
    await appStays(page);
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({animations:"disabled",path:auditDir+"restart-recovery-needs-inspection-dark-1280x800.png"});
  }finally{for(const route of held)await route.continue().catch(()=>{});await fixture.close()}
});

// The parts a person uses only once they do something, whose code left the app's first script (B11): the Cite button of text
// selected in a reply, the find bar of Ctrl+F and the sidebar's and the palette's searches of the threads, which load at idle after
// the first paint, and what a thread's moves and their Undo, the Snooze dialog's wake time and /goal work out, which load with the
// thread actions, the dialog and the turn support. Each is used for the first time right after the app opens, by mouse and by
// keyboard, and must draw within the frames it drew in when it came with the first script, counted from the press's own event and
// each checked before it paints (a part still on its way would come frames later, with nothing in its place meanwhile), and answer
// as it did. Ctrl+F's bar and a move draw in the press's own frame (1); Cite and a search's list come with the render after it (2),
// which a machine under load can put a frame later.
// The count starts at the press's own event: a click of detail clicks, or the keydown of key (Ctrl's own keydown comes before it).
const framesUntil=(page,{shown=null,gone=null,order=null},event,{detail=0,key=null}={})=>page.evaluate(([shown,gone,order,event,detail,key])=>{
  window.__drawnAfter=new Promise(resolve=>{
    const drawn=()=>order?[...document.querySelectorAll(".thread-main")].map(node=>node.title).join(",")===order:shown?Boolean(document.querySelector(shown)):!document.querySelector(gone);
    const start=input=>{
      if((input.detail||0)<detail||(key&&input.key!==key))return;removeEventListener(event,start,true);
      let frames=0;const tick=()=>{frames++;if(drawn())resolve(frames);else if(frames<120)requestAnimationFrame(tick);else resolve(null)};
      requestAnimationFrame(tick);
    };
    addEventListener(event,start,true);
  });
},[shown,gone,order,event,detail,key]);
const drawnAfter=page=>page.evaluate(()=>window.__drawnAfter);
// A person's first action comes once the app has opened: here once what it loads at idle after the first paint has come (the turn
// support is part of it in every build) and it asks for no other script. Armed before the page opens.
function scriptsSettled(page){
  let pending=0,last=Date.now(),idle=false;const script=request=>/\/assets\/[^/?]+\.js(?:\?.*)?$/.test(request.url());
  page.on("request",request=>{if(!script(request))return;pending++;last=Date.now();if(/\/turn-support-[^/]*\.js/.test(request.url()))idle=true});
  for(const event of ["requestfinished","requestfailed"])page.on(event,request=>{if(script(request)){pending--;last=Date.now()}});
  return ()=>expect.poll(()=>idle&&pending===0&&Date.now()-last>=300,{message:"the app's idle scripts loaded",intervals:[100],timeout:15_000}).toBe(true);
}
// Trebell Native threads with their history on the agent relay (relay-history-harness.js), each {name,user,reply} or a turn list
// [{user,reply}] given as turns, a minute apart, in a 1280x800 window opened on the new-task screen.
async function openRelayThreads(page,threads){
  const harness=await startRelayHarness();
  for(const [index,{name,user,reply,turns}] of threads.entries())harness.seedThread(name,(turns||[{user,reply}]).map((turn,at)=>({user:turn.user,items:[replyItem("reply-"+index+"-"+at,turn.reply)]})));
  const base=Math.floor(Date.now()/1000)-3600;harness.threads.forEach((thread,index)=>harness.threadStore.update(thread.id,{updatedAt:base-index*60},{touch:false}));
  const {sent}=await routeRelayApp(page,harness),settled=scriptsSettled(page),json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  // What Trebell keeps of each thread (its wake time among it), as the GUI server keeps it.
  const meta=Object.fromEntries(harness.threads.map(thread=>[thread.id,{projectless:false,environmentId:null,cwd:harness.repo,runtime:"native",runtimeInstanceId:"native-default"}]));
  await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>{
    const request=route.request(),body=request.method()==="POST"?request.postDataJSON()||{}:{},id=String(body.threadId||new URL(request.url()).searchParams.get("threadId")||"");
    if(request.method()==="POST")meta[id]={...(meta[id]||{}),...(body.patch||{})};
    return json(route,meta[id]||{});
  });
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await expect(page.locator(".thread-row")).toHaveCount(threads.length,{timeout:10_000});
  await expect(page.getByTestId("composer")).toBeVisible();
  return {harness,sent,settled};
}
const relayRow=(page,name)=>page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});
const relayGroups=page=>page.locator(".thread-sections section").evaluateAll(sections=>sections.map(section=>[section.querySelector("h4 .thread-group-name").textContent,[...section.querySelectorAll(".thread-main")].map(node=>node.title)]));
async function openRelayThread(page,name,reply){
  await relayRow(page,name).locator(".thread-main").click();
  await expect(page.locator(".assistant-message-text").last()).toContainText(reply);
  await expect(page.getByTestId("composer")).not.toHaveAttribute("placeholder","Opening thread…");
}

test("the Cite button of a first selection in a reply right after the app opens comes in its frames and cites, by mouse and by keyboard",async({page})=>{
  test.setTimeout(60_000);
  const PARAGRAPHS=["First paragraph about the session token.","Second paragraph about the refresh timer."];
  const {harness,settled}=await openRelayThreads(page,[{name:"Cite after open",user:"Explain the session handling",reply:PARAGRAPHS.join("\n\n")}]);
  try{
    await settled();
    await openRelayThread(page,"Cite after open",PARAGRAPHS[1]);
    const paragraphs=page.locator(".assistant-message-text").last().locator("p"),cite=page.getByTestId("assistant-selection-cite"),chips=page.getByTestId("context-chip");
    // By mouse: a triple-click selects the second paragraph, Cite comes with it, and a click on Cite takes the paragraph.
    await framesUntil(page,{shown:'[data-testid="assistant-selection-cite"]'},"mouseup",{detail:3});
    await paragraphs.nth(1).click({clickCount:3});
    const mouseFrames=await drawnAfter(page);console.log("frames from the selection to Cite:",mouseFrames);
    expect(mouseFrames,"frames from the selection to Cite").not.toBeNull();expect(mouseFrames).toBeLessThanOrEqual(3);
    await expect(cite).toHaveText("Cite");
    await cite.click();
    await expect(chips).toHaveCount(1);await expect(chips.first()).toContainText("Assistant excerpt");await expect(chips.first()).toContainText(PARAGRAPHS[1].length+" chars");
    await expect(cite).toHaveCount(0);
    // By keyboard: Escape takes Cite away from a selection; Tab from the selection reaches Cite, and Enter takes the paragraph.
    // (Each selection is let settle first: one still changing places Cite again where it ends.)
    const selectParagraph=async index=>{
      await paragraphs.nth(index).click({clickCount:3});await expect(cite).toBeVisible();
      await expect.poll(()=>page.evaluate(()=>String(getSelection()).trim())).toBe(PARAGRAPHS[index]);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    };
    await selectParagraph(0);
    await page.keyboard.press("Escape");await expect(cite).toHaveCount(0);
    await selectParagraph(0);
    await page.keyboard.press("Tab");await expect(cite).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(chips).toHaveCount(2);await expect(chips.nth(1)).toContainText(PARAGRAPHS[0].length+" chars");
    await page.screenshot({animations:"disabled",path:auditDir+"lazy-cite-first-selection-dark-1280x800.png"});
    await appStays(page);
  }finally{await harness.close()}
});

test("the find bar of a first Ctrl+F right after the app opens comes in the frame of the key, finds and closes, by keyboard and by mouse",async({page})=>{
  test.setTimeout(60_000);
  const needle="amber-lantern-512";
  const {harness,settled}=await openRelayThreads(page,[{name:"Find after open",turns:[{user:`Note ${needle} for later`,reply:"Noted the first one."},{user:"Something else",reply:`The second ${needle} is here.`}]}]);
  try{
    await settled();
    await openRelayThread(page,"Find after open",`The second ${needle} is here.`);
    const bar=page.getByTestId("thread-find-bar"),input=page.getByTestId("thread-find-input"),count=bar.locator(".thread-find-count");
    // By keyboard: Ctrl+F shows the bar with the keyboard in its field, Enter steps through the matches and Escape closes it.
    await framesUntil(page,{shown:'[data-testid="thread-find-bar"]'},"keydown",{key:"f"});
    await page.keyboard.press("Control+f");
    const keyFrames=await drawnAfter(page);console.log("frames from Ctrl+F to the find bar:",keyFrames);
    expect(keyFrames,"frames from Ctrl+F to the find bar").toBe(1);
    await expect(input).toBeFocused();
    await page.keyboard.type(needle);
    await expect(count).toHaveText("1 / 2",{timeout:10_000});
    await page.keyboard.press("Enter");await expect(count).toHaveText("2 / 2");
    await page.keyboard.press("Shift+Enter");await expect(count).toHaveText("1 / 2");
    await page.keyboard.press("Escape");await expect(bar).toHaveCount(0);
    // By mouse: Next and Previous match step, and Close find closes it.
    await page.keyboard.press("Control+f");await expect(input).toBeFocused();
    await input.fill(needle);await expect(count).toHaveText("1 / 2",{timeout:10_000});
    await bar.getByRole("button",{name:"Next match"}).click();await expect(count).toHaveText("2 / 2");
    await bar.getByRole("button",{name:"Previous match"}).click();await expect(count).toHaveText("1 / 2");
    await page.screenshot({animations:"disabled",path:auditDir+"lazy-find-first-ctrl-f-dark-1280x800.png"});
    await bar.getByRole("button",{name:"Close find"}).click();await expect(bar).toHaveCount(0);
    await appStays(page);
  }finally{await harness.close()}
});

test("a first search of the sidebar or the palette right after the app opens filters and finds as before, by keyboard and by mouse",async({page})=>{
  test.setTimeout(60_000);
  const needle="violet-harbor-207";
  const {harness,settled}=await openRelayThreads(page,[{name:"Quill release",user:"Plan the release",reply:"The release plan is ready."},{name:"Beta notes",user:"Write the notes",reply:`The notes mention ${needle} once.`}]);
  try{
    await settled();
    const search=page.getByRole("textbox",{name:"Search threads"}),alpha=relayRow(page,"Quill release"),beta=relayRow(page,"Beta notes");
    // By keyboard: Search threads/projects (Ctrl+Shift+F) puts the keyboard in the search; its first letter filters the list at once
    // (Q: only Quill release has one, its project's name none).
    await page.keyboard.press("Control+Shift+F");await expect(search).toBeFocused();
    await framesUntil(page,{gone:'.thread-main[title="Beta notes"]'},"input");
    await page.keyboard.type("Q");
    const typedFrames=await drawnAfter(page);console.log("frames from the first letter to the filtered list:",typedFrames);
    expect(typedFrames,"frames from the first letter to the filtered list").not.toBeNull();expect(typedFrames).toBeLessThanOrEqual(3);
    await expect(alpha).toBeVisible();await expect(beta).toHaveCount(0);
    // A word only a message holds finds that message's thread.
    await page.keyboard.press("Escape");await expect(search).toHaveValue("");await expect(beta).toBeVisible();
    await page.keyboard.type(needle);
    await expect(beta).toBeVisible({timeout:10_000});await expect(alpha).toHaveCount(0);
    await expect(page.locator(".sidebar .sidebar-action-error")).toHaveCount(0);
    // By mouse: the search found by its field, and the thread it finds opens with a click.
    await page.keyboard.press("Escape");await expect(alpha).toBeVisible();
    await search.click();await search.fill("Beta");await expect(alpha).toHaveCount(0);
    await beta.locator(".thread-main").click();await expect(page.locator(".assistant-message-text").last()).toContainText(needle);
    // The palette finds the message too, and its thread opens from there with a click or with Enter.
    await search.fill("");
    await page.getByRole("button",{name:"Search or jump to"}).click();
    const palette=page.getByTestId("command-palette");await expect(palette).toBeVisible();
    await page.keyboard.type(needle);
    const found=palette.locator(".command-palette-item.message-match").filter({hasText:"Beta notes"});
    await expect(found).toBeVisible({timeout:10_000});
    await page.screenshot({animations:"disabled",path:auditDir+"lazy-search-first-palette-dark-1280x800.png"});
    await found.click();await expect(palette).toHaveCount(0);
    await alpha.locator(".thread-main").click();await expect(page.locator(".assistant-message-text").last()).toContainText("The release plan is ready.");
    await page.keyboard.press("Control+k");await expect(palette).toBeVisible();
    await page.keyboard.type(needle);await expect(found).toBeVisible({timeout:10_000});
    await found.focus();await page.keyboard.press("Enter");await expect(palette).toHaveCount(0);
    await expect(page.locator(".assistant-message-text").last()).toContainText(needle);
    await appStays(page);
  }finally{await harness.close()}
});

test("a first Move up right after the app opens shows at once, and a Pin's Undo puts the thread back in its place, by mouse and by keyboard",async({page})=>{
  test.setTimeout(60_000);
  const names=["Move one","Move two","Move three"];
  const {harness,settled}=await openRelayThreads(page,names.map(name=>({name,user:"Work on "+name.toLowerCase(),reply:"Done with "+name.toLowerCase()+"."})));
  try{
    await settled();
    await expect.poll(()=>relayGroups(page)).toEqual([["Active",names]]);
    const undo=page.getByTestId("thread-undo-toast");
    // A row's menu item, from the keyboard: Tab from the row to its menu button, Enter, then Tab to the item, which Enter runs.
    const fromKeyboard=async(name,item)=>{
      const row=relayRow(page,name),menu=row.locator(".thread-menu summary");
      await row.locator(".thread-main").focus();await page.keyboard.press("Tab");await expect(menu).toBeFocused();
      await page.keyboard.press("Enter");await expect(row.locator(".thread-menu")).toHaveAttribute("open","");
      const button=row.getByRole("button",{name:item,exact:true});
      for(let step=0;step<8&&!(await button.evaluate(node=>node===document.activeElement));step++)await page.keyboard.press("Tab");
      await expect(button).toBeFocused();await page.keyboard.press("Enter");
    };
    // By mouse: the row's menu, Move up; the list shows the move in the frames it did.
    const row=relayRow(page,"Move three");await row.hover();await row.locator(".thread-menu summary").click();
    await framesUntil(page,{order:"Move one,Move three,Move two"},"click");
    await row.getByRole("button",{name:"Move up",exact:true}).click();
    const moveFrames=await drawnAfter(page);console.log("frames from Move up to the move:",moveFrames);
    expect(moveFrames,"frames from Move up to the move").not.toBeNull();expect(moveFrames).toBeLessThanOrEqual(1);
    await expect.poll(()=>relayGroups(page)).toEqual([["Active",["Move one","Move three","Move two"]]]);
    // A Pin, and its Undo from the toast: the thread goes back to the place it held.
    const first=relayRow(page,"Move three");await first.hover();await first.locator(".thread-menu summary").click();
    await first.getByRole("button",{name:"Pin",exact:true}).click();
    await expect.poll(()=>relayGroups(page)).toEqual([["Pinned",["Move three"]],["Active",["Move one","Move two"]]]);
    await expect(undo.locator("span").first()).toHaveText("Thread pinned");
    await undo.getByRole("button",{name:"Undo",exact:true}).click();
    await expect.poll(()=>relayGroups(page)).toEqual([["Active",["Move one","Move three","Move two"]]]);
    // By keyboard: Move up on Move two, then a Pin of it and Undo recent thread action (Ctrl+Z).
    await fromKeyboard("Move two","Move up");
    await expect.poll(()=>relayGroups(page)).toEqual([["Active",["Move one","Move two","Move three"]]]);
    await fromKeyboard("Move two","Pin");
    await expect.poll(()=>relayGroups(page)).toEqual([["Pinned",["Move two"]],["Active",["Move one","Move three"]]]);
    await expect(undo.locator("span").first()).toHaveText("Thread pinned");
    await page.keyboard.press("Control+z");
    await expect.poll(()=>relayGroups(page)).toEqual([["Active",["Move one","Move two","Move three"]]]);
    await appStays(page);
  }finally{await harness.close()}
});

test("a first Snooze right after the app opens takes its wake time from the dialog, by mouse and by keyboard",async({page})=>{
  test.setTimeout(60_000);
  const names=["Snooze one","Snooze two"];
  const {harness,settled}=await openRelayThreads(page,names.map(name=>({name,user:"Work on "+name.toLowerCase(),reply:"Done with "+name.toLowerCase()+"."})));
  try{
    await settled();
    const dialog=page.getByRole("dialog",{name:/^Snooze/}),wakes=name=>relayRow(page,name).locator(".thread-main>div>span");
    // By mouse: the row's menu, Snooze…, 2 hours, Snooze: the thread goes to Snoozed and says when it wakes, as the dialog said.
    const row=relayRow(page,"Snooze one");await row.hover();await row.locator(".thread-menu summary").click();
    await row.getByRole("button",{name:"Snooze…",exact:true}).click();
    await expect(dialog).toBeVisible();await expect(dialog.getByLabel("Snooze duration")).toBeFocused();
    const hint=dialog.locator(".snooze-hint"),wakeSaid=async()=>{await expect(hint).toHaveText(/^Wakes .+\.$/);return (await hint.textContent()).replace(/\.$/,"")};
    await dialog.getByLabel("Snooze duration").fill("2");await expect(dialog.getByLabel("Snooze duration")).toHaveValue("2");const said=await wakeSaid();
    await dialog.getByRole("button",{name:"Snooze",exact:true}).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(()=>relayGroups(page)).toEqual([["Active",["Snooze two"]],["Snoozed",["Snooze one"]]]);
    await expect(wakes("Snooze one")).toHaveText(said);
    // By keyboard: Tab from the row to its menu button, Enter, Tab to Snooze…, Enter, a duration of 3 hours typed, Enter.
    const second=relayRow(page,"Snooze two"),menu=second.locator(".thread-menu summary");
    await second.locator(".thread-main").focus();await page.keyboard.press("Tab");await expect(menu).toBeFocused();
    await page.keyboard.press("Enter");await expect(second.locator(".thread-menu")).toHaveAttribute("open","");
    await page.keyboard.press("Tab");await page.keyboard.press("Tab");await expect(second.getByRole("button",{name:"Snooze…",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");await expect(dialog.getByLabel("Snooze duration")).toBeFocused();
    await page.keyboard.press("Control+a");await page.keyboard.type("3");await expect(dialog.getByLabel("Snooze duration")).toHaveValue("3");const saidAgain=await wakeSaid();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect.poll(()=>relayGroups(page)).toEqual([["Snoozed",["Snooze one","Snooze two"]]]);
    await expect(wakes("Snooze two")).toHaveText(saidAgain);
    await appStays(page);
  }finally{await harness.close()}
});

test("a first /goal right after the app opens sets the thread's goal, by keyboard and by mouse",async({page})=>{
  test.setTimeout(60_000);
  const {harness,settled}=await openRelayThreads(page,[{name:"Goal after open",user:"Start the work",reply:"Started the work."}]);
  try{
    await settled();
    await openRelayThread(page,"Goal after open","Started the work.");
    const composer=page.getByTestId("composer"),panel=page.getByTestId("goal-panel"),objective=panel.getByLabel("Objective",{exact:true}),status=panel.locator(".goal-status");
    // By keyboard: /goal with an objective, Enter; the Goal panel opens on the goal set.
    await composer.click();await page.keyboard.type("/goal Make the login tests pass",{delay:15});await page.keyboard.press("Enter");
    await expect(objective).toHaveValue("Make the login tests pass");await expect(status).toHaveText("active");await expect(composer).toHaveValue("");
    // By mouse: /goal pause with Send pauses it, the objective kept.
    await composer.fill("/goal pause");await page.getByTestId("send").click();
    await expect(status).toHaveText("paused");await expect(objective).toHaveValue("Make the login tests pass");await expect(composer).toHaveValue("");
    await appStays(page);
  }finally{await harness.close()}
});

// The Cite button, the find bar and the threads' searches come in one script (idle-parts.js). What is done before it has come waits
// for it: text selected in a reply gets its Cite once it is in, a sidebar search filters the list then, and a Ctrl+F opens the find
// bar then, with the keyboard in its field.
test("a selection, a search and a Ctrl+F made before the parts loaded at idle have come wait for them and draw once they are in",async({page})=>{
  test.setTimeout(60_000);
  const held=[];
  await page.route(/\/assets\/idle-parts-[^/]*\.js$/,route=>{held.push(route)});
  const {harness}=await openRelayThreads(page,[{name:"Quill release",user:"Plan the release",reply:"The release plan is ready."},{name:"Beta notes",user:"Write the notes",reply:"The notes are written."}]);
  const release=async()=>{for(const route of held.splice(0))await route.continue()};
  try{
    await expect.poll(()=>held.length,{message:"the parts asked for at idle"}).toBe(1);
    await openRelayThread(page,"Quill release","The release plan is ready.");
    const cite=page.getByTestId("assistant-selection-cite");
    await page.locator(".assistant-message-text").last().locator("p").first().click({clickCount:3});
    await page.waitForTimeout(500);await expect(cite).toHaveCount(0);
    await release();
    await expect(cite).toBeVisible();
    await page.reload();
    await expect.poll(()=>held.length,{message:"the parts asked for at idle again"}).toBe(1);
    await openRelayThread(page,"Quill release","The release plan is ready.");
    const search=page.getByRole("textbox",{name:"Search threads"}),beta=relayRow(page,"Beta notes"),bar=page.getByTestId("thread-find-bar");
    await search.click();await page.keyboard.type("Q");
    await page.waitForTimeout(500);await expect(beta).toBeVisible();
    await page.keyboard.press("Control+f");
    await page.waitForTimeout(500);await expect(bar).toHaveCount(0);
    await release();
    await expect(beta).toHaveCount(0);await expect(relayRow(page,"Quill release")).toBeVisible();
    await expect(bar).toBeVisible();await expect(page.getByTestId("thread-find-input")).toBeFocused();
    await appStays(page);
  }finally{await release().catch(()=>{});await harness.close()}
});

// A Ctrl+F made before that script has come opens the find bar of the thread it was pressed on, and only there: a new task (Ctrl+N)
// or another thread (its row clicked) shown by the time the script comes gets no bar, and the keyboard stays in its composer, where
// what is typed goes. A script that cannot load then says nothing there either. findBeforeTheParts holds the script, opens Quill
// release and presses Ctrl+F there; settle lets the script come (or fail), then waits as long again as the bar takes to come once
// it is in, and checks there is no bar, nothing in its place, and the keyboard still in the composer.
async function findBeforeTheParts(page){
  const held=[];let refuse=false;
  await page.route(/\/assets\/idle-parts-[^/]*\.js$/,route=>refuse?route.abort("failed"):held.push(route));
  const {harness}=await openRelayThreads(page,[{name:"Quill release",user:"Plan the release",reply:"The release plan is ready."},{name:"Beta notes",user:"Write the notes",reply:"The notes are written."}]);
  const composer=page.getByTestId("composer"),bar=page.getByTestId("thread-find-bar"),title=page.locator(".thread-title-button strong");
  try{
    await expect.poll(()=>held.length,{message:"the parts asked for at idle"}).toBe(1);
    await openRelayThread(page,"Quill release","The release plan is ready.");
    await page.keyboard.press("Control+f");
    await page.waitForTimeout(300);await expect(bar).toHaveCount(0);
  }catch(error){await harness.close();throw error}
  return {
    composer,title,
    async settle(outcome="loads"){
      const settled=page.waitForEvent(outcome==="loads"?"requestfinished":"requestfailed",request=>/\/assets\/idle-parts-[^/]*\.js$/.test(request.url()));
      refuse=outcome!=="loads";for(const route of held.splice(0))await (refuse?route.abort("failed"):route.continue());
      await settled;
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.waitForTimeout(400);
      await expect(bar).toHaveCount(0);await expect(page.locator(".chat-workspace > .lazy-slot-error")).toHaveCount(0);
      await expect(composer).toBeFocused();
    },
    async close(){for(const route of held.splice(0))await route.continue().catch(()=>{});await harness.close()},
  };
}
test("a Ctrl+F made before the parts loaded at idle have come opens no find bar on the new task Ctrl+N shows meanwhile, and the keyboard stays in its composer",async({page})=>{
  test.setTimeout(60_000);
  const find=await findBeforeTheParts(page);
  try{
    await page.keyboard.press("Control+n");
    await expect(find.title).toHaveText("New Trebell task");await expect(find.composer).toBeFocused();
    await find.settle();
    await page.keyboard.type("Plan the next release",{delay:15});await expect(find.composer).toHaveValue("Plan the next release");
    await appStays(page);
    await page.screenshot({animations:"disabled",path:auditDir+"find-before-load-then-new-task-dark-1280x800.png"});
  }finally{await find.close()}
});
test("a Ctrl+F made before the parts loaded at idle have come opens no find bar on another thread whose row is clicked meanwhile, and the keyboard stays in its composer",async({page})=>{
  test.setTimeout(60_000);
  const find=await findBeforeTheParts(page);
  try{
    await relayRow(page,"Beta notes").locator(".thread-main").click();
    await expect(page.locator(".assistant-message-text").last()).toContainText("The notes are written.");await expect(find.title).toHaveText("Beta notes");
    await find.composer.click();await expect(find.composer).toBeFocused();
    await find.settle();
    await page.keyboard.type("Add the dates",{delay:15});await expect(find.composer).toHaveValue("Add the dates");
    await appStays(page);
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"find-before-load-then-other-thread-light-1280x800.png"});
  }finally{await find.close()}
});
test("a Ctrl+F whose parts then cannot load says nothing on the new task Ctrl+N shows meanwhile, and the keyboard stays in its composer",async({page})=>{
  test.setTimeout(60_000);
  const find=await findBeforeTheParts(page);
  try{
    await page.keyboard.press("Control+n");
    await expect(find.title).toHaveText("New Trebell task");await expect(find.composer).toBeFocused();
    await find.settle("fails");
    await expect(page.getByTestId("app-action-error")).toHaveCount(0);
    await appStays(page);
  }finally{await find.close()}
});

// When that script cannot load, each part says so where it is used, and the rest of the app stays. A Ctrl+F says why in the line the
// app's actions say their errors in and opens nothing over the conversation, whose first message stays in view, with the keyboard
// still in the composer; the sidebar's search says it could not search.
test("a Ctrl+F whose find bar cannot load says why, opens nothing over the conversation and leaves the keyboard in the composer, and a search says it could not search",async({page})=>{
  test.setTimeout(60_000);
  let refused=0;
  await page.route(/\/assets\/idle-parts-[^/]*\.js$/,route=>{refused++;return route.abort("failed")});
  const {harness}=await openRelayThreads(page,[{name:"Quill release",user:"Plan the release",reply:"The release plan is ready."},{name:"Beta notes",user:"Write the notes",reply:"The notes are written."}]);
  try{
    await expect.poll(()=>refused,{message:"the parts asked for at idle"}).toBeGreaterThan(0);
    await openRelayThread(page,"Quill release","The release plan is ready.");
    const composer=page.getByTestId("composer"),said=page.getByTestId("app-action-error");
    await composer.click();await page.keyboard.press("Control+f");
    await expect(said).toHaveText("Could not open find in this thread: Part of Trebell could not load. Reload Trebell to get it back.");
    await expect(page.getByTestId("thread-find-bar")).toHaveCount(0);await expect(page.locator(".chat-workspace > .lazy-slot-error")).toHaveCount(0);
    await expect(composer).toBeFocused();await expect(page.locator(".user-bubble").first()).toBeVisible();
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
      await page.screenshot({animations:"disabled",path:auditDir+`find-cannot-load-${mode}-1280x800.png`});
    }
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    await page.keyboard.type("Plan the notes",{delay:15});await expect(composer).toHaveValue("Plan the notes");
    await page.getByRole("textbox",{name:"Search threads"}).fill("Q");
    await expect(page.locator(".sidebar .sidebar-action-error")).toHaveText("Could not search threads: Part of Trebell could not load. Reload Trebell to get it back.");
    await expect(relayRow(page,"Beta notes")).toBeVisible();
    await appStays(page);
    await page.screenshot({animations:"disabled",path:auditDir+"idle-parts-cannot-load-dark-1280x800.png"});
  }finally{await harness.close()}
});

// The palette finds threads by their names with code of its own, so one whose message search cannot load still does. It says what it
// could not do, as the sidebar's search and Ctrl+F say theirs, with Reload, and a word only a message holds reads as matching no
// command or thread name: it said only "Part of Trebell could not load…", above "No matching command or thread.".
test("a palette whose message search cannot load says it could not search thread messages, with Reload, and still finds threads by name, by keyboard and by mouse",async({page})=>{
  test.setTimeout(90_000);
  const needle="violet-harbor-207";
  let refuse=true,refused=0;
  await page.route(/\/assets\/idle-parts-[^/]*\.js$/,route=>{if(!refuse)return route.continue();refused++;return route.abort("failed")});
  const {harness}=await openRelayThreads(page,[{name:"Quill release",user:"Plan the release",reply:"The release plan is ready."},{name:"Beta notes",user:"Write the notes",reply:`The notes mention ${needle} once.`}]);
  try{
    await expect.poll(()=>refused,{message:"the parts asked for at idle"}).toBeGreaterThan(0);
    const palette=page.getByTestId("command-palette"),said=palette.getByRole("alert"),reload=said.getByRole("button",{name:"Reload",exact:true}),empty=palette.locator(".command-palette-empty");
    const notice=/^Could not search thread messages: Part of Trebell could not load\. Reload Trebell to get it back\.\s*Reload$/;
    // By keyboard: Ctrl+K from the composer, and a word only Beta notes' reply holds.
    await page.getByTestId("composer").click();await page.keyboard.press("Control+k");await expect(palette).toBeVisible();
    await page.keyboard.type(needle,{delay:15});
    await expect(said).toHaveText(notice);
    await expect(empty).toHaveText("No matching command or thread name.");await expect(palette.locator(".command-palette-item")).toHaveCount(0);
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
      for(const width of [1280,700]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+`palette-message-search-cannot-load-${mode}-${width}x800.png`})}
    }
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await page.setViewportSize({width:1280,height:800});
    // A thread's name still finds the thread, and the palette still says what it could not search.
    await page.keyboard.press("Control+a");await page.keyboard.type("Quill",{delay:15});
    await expect(palette.locator(".command-palette-item").filter({hasText:"Quill release"})).toBeVisible();
    await expect(said).toHaveText(notice);await expect(empty).toHaveCount(0);
    // Tab from the search reaches Reload, which takes keys as a result does: a letter typed there goes back to the search box, where it
    // lands, ArrowDown goes on to the first result and ArrowUp back to the search box, and none of them loads Trebell again. Arrows did
    // nothing there and letters were lost (round 10 repair).
    const search=palette.getByPlaceholder("Search commands, threads, and messages…"),quill=palette.locator(".command-palette-item").filter({hasText:"Quill release"});
    let loads=0;page.on("load",()=>loads++);
    await page.keyboard.press("Tab");await expect(reload).toBeFocused();
    await page.keyboard.type("e",{delay:15});
    await expect.soft(search,"the search box after a letter typed on Reload").toBeFocused();await expect.soft(search,"the search after a letter typed on Reload").toHaveValue("Quille");
    await search.fill("Quill");await expect(quill).toBeVisible();await expect(said).toHaveText(notice);
    await page.keyboard.press("Tab");await expect(reload).toBeFocused();
    await page.keyboard.press("ArrowDown");await expect.soft(quill,"the first result after ArrowDown on Reload").toBeFocused();
    await reload.focus();await page.keyboard.press("ArrowUp");await expect.soft(search,"the search box after ArrowUp on Reload").toBeFocused();
    await page.screenshot({animations:"disabled",path:auditDir+"palette-message-search-cannot-load-keys-on-reload-dark-1280x800.png"});
    await page.waitForTimeout(500);expect(loads,"loads of Trebell made by the keys on Reload").toBe(0);await expect(said).toHaveText(notice);
    // Enter on Reload loads Trebell again.
    await search.focus();await page.keyboard.press("Tab");await expect(reload).toBeFocused();
    await Promise.all([page.waitForEvent("load"),page.keyboard.press("Enter")]);
    await expect(page.locator(".thread-row")).toHaveCount(2,{timeout:10_000});
    // By mouse: Search or jump to, the word, and a click on Reload, which brings the message search back with the script let through.
    await page.getByRole("button",{name:"Search or jump to"}).click();await expect(palette).toBeVisible();
    await page.keyboard.type(needle,{delay:15});await expect(said).toHaveText(notice);
    refuse=false;
    await Promise.all([page.waitForEvent("load"),reload.click()]);
    await expect(page.locator(".thread-row")).toHaveCount(2,{timeout:10_000});
    await page.getByRole("button",{name:"Search or jump to"}).click();await expect(palette).toBeVisible();
    await page.keyboard.type(needle,{delay:15});
    await expect(palette.locator(".command-palette-item.message-match").filter({hasText:"Beta notes"})).toBeVisible({timeout:10_000});
    await expect(said).toHaveCount(0);
    await appStays(page);
  }finally{await harness.close()}
});

// Nor does Cite's: the end of a conversation says nothing (no reply reads as failed to show, and nothing there is announced or in
// Tab's order). Text selected in a reply says it, where Cite would come and for as long as the selection lasts, with Reload.
test("a Cite whose script cannot load says so only where its button would come, above text selected in a reply, by mouse and by keyboard",async({page})=>{
  test.setTimeout(60_000);
  let refused=0;
  await page.route(/\/assets\/idle-parts-[^/]*\.js$/,route=>{refused++;return route.abort("failed")});
  const {harness}=await openRelayThreads(page,[{name:"Quill release",user:"Plan the release",reply:"The release plan is ready."},{name:"Beta notes",user:"Write the notes",reply:"The notes are written."}]);
  try{
    await expect.poll(()=>refused,{message:"the parts asked for at idle"}).toBeGreaterThan(0);
    await openRelayThread(page,"Quill release","The release plan is ready.");
    const history=page.locator(".conversation-history"),notice=page.locator(".cite-unavailable"),reload=notice.getByRole("button",{name:"Reload",exact:true});
    const reply=()=>page.locator(".assistant-message-text").last().locator("p").first();
    // By mouse: a triple-click selects the reply, and the notice comes where Cite would, centred above the selection.
    await reply().click({clickCount:3});
    await expect(notice).toBeVisible();await expect(notice).toHaveText(/^Cite could not load\.\s*Reload$/);await expect(notice).toHaveAttribute("role","alert");
    const place=await page.evaluate(()=>{
      const range=getSelection().getRangeAt(0).getBoundingClientRect(),box=document.querySelector(".cite-unavailable").getBoundingClientRect();
      return {offCentre:Math.abs((box.left+box.right)/2-(range.left+range.right)/2),gap:range.top-box.bottom,inWindow:box.left>=0&&box.right<=innerWidth};
    });
    expect(place.offCentre,"how far the notice is off the selection's centre").toBeLessThan(2);
    expect(place.gap,"the gap from the notice down to the selection").toBeGreaterThanOrEqual(0);expect(place.gap).toBeLessThanOrEqual(12);expect(place.inWindow).toBe(true);
    await expect(history.locator(".lazy-slot-error")).toHaveCount(1);await expect(history.getByRole("alert")).toHaveCount(1);
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
      await page.screenshot({animations:"disabled",path:auditDir+`cite-cannot-load-selected-${mode}-1280x800.png`});
    }
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    // A click beside the reply takes the selection, and the notice with it: the end of the conversation says nothing.
    await page.locator(".conversation-column").click({position:{x:5,y:5}});
    await expect(notice).toHaveCount(0);
    await expect(history.locator(".lazy-slot-error")).toHaveCount(0);await expect(history.getByRole("alert")).toHaveCount(0);await expect(history.getByRole("button",{name:"Reload"})).toHaveCount(0);
    // Nor does another thread's.
    await openRelayThread(page,"Beta notes","The notes are written.");
    await page.waitForTimeout(300);
    await expect(history.locator(".lazy-slot-error")).toHaveCount(0);await expect(history.getByRole("alert")).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:auditDir+"cite-cannot-load-unselected-dark-1280x800.png"});
    // By keyboard: Tab from a selection reaches Reload, as it reaches Cite, and Escape takes the notice away.
    await reply().click({clickCount:3});await expect(notice).toBeVisible();
    await page.keyboard.press("Tab");await expect(reload).toBeFocused();
    await page.keyboard.press("Escape");await expect(notice).toHaveCount(0);
    // Reload loads Trebell again, from the keyboard and with a click.
    await reply().click({clickCount:3});await expect(notice).toBeVisible();
    await page.keyboard.press("Tab");await expect(reload).toBeFocused();
    await Promise.all([page.waitForEvent("load"),page.keyboard.press("Enter")]);
    await expect(page.locator(".thread-row")).toHaveCount(2,{timeout:10_000});
    await openRelayThread(page,"Quill release","The release plan is ready.");
    await reply().click({clickCount:3});await expect(notice).toBeVisible();
    await Promise.all([page.waitForEvent("load"),reload.click()]);
    await expect(page.locator(".thread-row")).toHaveCount(2,{timeout:10_000});
    await appStays(page);
  }finally{await harness.close()}
});

// The notice comes after the conversation's last message in the page's order, as Cite does, so Tab from text selected in a reply that
// was not the last went to the next message's Edit from here, and Shift+Tab to the one before. Both reach its Reload from any reply.
test("the Reload of a Cite whose script cannot load is reached by Tab and Shift+Tab from text selected in any reply, not only the last",async({page})=>{
  test.setTimeout(60_000);
  let refused=0;
  await page.route(/\/assets\/idle-parts-[^/]*\.js$/,route=>{refused++;return route.abort("failed")});
  const {harness}=await openRelayThreads(page,[{name:"Quill release",turns:[{user:"Plan the release",reply:"The release plan is ready."},{user:"Thanks for that",reply:"Glad to help."}]}]);
  try{
    await expect.poll(()=>refused,{message:"the parts asked for at idle"}).toBeGreaterThan(0);
    await openRelayThread(page,"Quill release","Glad to help.");
    const notice=page.locator(".cite-unavailable"),reload=notice.getByRole("button",{name:"Reload",exact:true});
    const earlier=page.locator(".assistant-message-text").first().locator("p").first(),editFromHere=page.locator(".user-bubble").getByRole("button",{name:"Edit from here",exact:true});
    await expect(earlier).toHaveText("The release plan is ready.");await expect(editFromHere).toHaveCount(2);
    for(const key of ["Tab","Shift+Tab"]){
      await earlier.click({clickCount:3});await expect(notice).toBeVisible();
      await page.keyboard.press(key);await expect(reload,key+" from text selected in the earlier reply").toBeFocused();
      await page.keyboard.press("Escape");await expect(notice).toHaveCount(0);
    }
    // With the notice away, Tab goes where it went: to the next message's Edit from here.
    await earlier.click({clickCount:3});await expect(notice).toBeVisible();
    await page.keyboard.press("Escape");await expect(notice).toHaveCount(0);
    await page.keyboard.press("Tab");await expect(editFromHere.nth(1)).toBeFocused();
    // Enter on the Reload reached so loads Trebell again.
    await earlier.click({clickCount:3});await expect(notice).toBeVisible();
    await page.keyboard.press("Tab");await expect(reload).toBeFocused();
    await page.screenshot({animations:"disabled",path:auditDir+"cite-cannot-load-tab-from-an-earlier-reply-dark-1280x800.png"});
    await Promise.all([page.waitForEvent("load"),page.keyboard.press("Enter")]);
    await expect(page.locator(".thread-row")).toHaveCount(1,{timeout:10_000});
    await appStays(page);
  }finally{await harness.close()}
});
