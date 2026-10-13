import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";
import { auditDir,startStreamingFixture } from "./native-stream-fixture.js";

// The parts of the app whose code loads after the first paint (lazy chunks), when that code cannot load: the UI was rebuilt or
// updated under an open page, or the link to a remote Trebell server dropped. The browser keeps such a module as failed, so the
// part cannot come until the page reloads; it must say so in its place and leave the rest of the app on screen.

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// A Codex app-server stand-in behind the real Codex relay, as guardian.spec.js builds it: one thread; send() pushes a message from
// the harness to the page, and messages holds what the page sent it (its answers to the harness's requests among them).
async function codexFixture(page){
  const thread={id:"lazy-chunk-fixture",name:"Lazy chunk fixture",preview:"Lazy chunks",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  let socket=null;const messages=[];
  const upstreamHttp=createServer(),upstreamWss=new WebSocketServer({noServer:true}),sockets=new Set();
  upstreamHttp.on("upgrade",(req,raw,head)=>upstreamWss.handleUpgrade(req,raw,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);socket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));messages.push(message);if(message.id==null||!message.method)return;let result={};
      if(message.method==="initialize")result={userAgent:"lazy-chunk-fixture"};
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
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  return {
    thread,messages,send:message=>socket.send(JSON.stringify(message)),
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

// A harness waits on its approval, so the approval card is part of the app's first script: it shows the moment the request comes
// and is answered with no script left to load.
test("an approval shows the moment it is asked and is answered with no script left to load",async({page})=>{
  test.setTimeout(45_000);
  const fixture=await codexFixture(page);
  try{
    await page.goto("/");await page.getByRole("button",{name:/Lazy chunk fixture/}).click();
    await expect(page.locator(".welcome")).toBeVisible();
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
    await page.goto("/");await page.getByRole("button",{name:/Lazy chunk fixture/}).click();
    await expect(page.locator(".welcome")).toBeVisible();
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
