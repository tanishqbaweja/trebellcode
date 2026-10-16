import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";
import { auditDir,gate,startStreamingFixture } from "./native-stream-fixture.js";

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
// plan prompt to send, and nothing goes to the model.
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
    await expect(page.getByTestId("composer")).toHaveValue("/plan the release");
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
