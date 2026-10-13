import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";
import { mkdirSync } from "node:fs";
import { auditDir } from "./native-stream-fixture.js";

// The proof shots of this round's fixes, when the run names a folder for them.
const SHOTS=process.env.TREBELL_PROOF_SHOTS?String(process.env.TREBELL_PROOF_SHOTS).replace(/[\\/]*$/,"/"):auditDir+"proof-";
if(process.env.TREBELL_PROOF_SHOTS)mkdirSync(SHOTS,{recursive:true});

// A Codex thread runs on an app-server of its own. One that dies closes the app's socket (1011), and the app connects again and
// reopens the thread shown. The relay here is the real one (attachCodexRelay); the pool behind it does what gui-server's
// codexRelayTarget and ensureCodexAppServer do: a request about a thread whose app-server is dead starts it again (one Codex launch),
// requests that come while it starts share that start, and a start that failed answers the thread's requests with its failure for
// 10 s (CODEX_THREAD_START_RETRY_MS) before a request launches Codex once more.

async function freePort(){
  const server=createServer();await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

const THREAD="app-server-death-thread";
async function fakeAppServer(name){
  const http=createServer((_req,res)=>{res.writeHead(404);res.end()}),wss=new WebSocketServer({noServer:true}),sockets=new Set(),requests=[];
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push(message);
      const now=Date.now()/1000;let result={};
      if(message.method==="initialize")result={userAgent:"app-server-death-"+name};
      else if(message.method==="thread/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/start")result={thread:{id:THREAD,name:"App-server death fixture",cwd:process.cwd(),createdAt:now,updatedAt:now,turns:[]}};
      else if(message.method==="thread/resume")result={thread:{id:THREAD,name:"App-server death fixture",preview:"App-server death fixture",historyMode:"paginated",cwd:process.cwd(),createdAt:now,updatedAt:now,status:{type:"idle"},turns:[]},itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="turn/start")result={turn:{id:"death-turn",status:"inProgress",items:[]}};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(["thread/attachment/list","thread/queue/list","threadSection/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {url:"ws://127.0.0.1:"+port,requests,
    // Its connections drop, and it goes on listening.
    drop(){for(const ws of sockets)try{ws.terminate()}catch{}},
    // A crash: its connections drop without a close frame and its port stops listening.
    kill(){for(const ws of sockets)try{ws.terminate()}catch{}try{wss.close()}catch{}try{http.close()}catch{}},
  };
}

async function startFixture(page){
  const catalog=await fakeAppServer("catalog"),threadServer=await fakeAppServer("thread");
  const pool=new Map([["catalog",{url:catalog.url}],["start:1",{url:threadServer.url}]]),threadKeys=new Map(),starts=new Map(),launches=[],restarted=[];
  const fixture={catalog,threadServer,launches,restarted,broken:false};
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachCodexRelay(relayHttp,{
    targetUrl:catalog.url,
    resolveTarget:async message=>{
      const threadId=String(message?.params?.threadId||message?.params?._trebellThreadId||"").trim();
      if(message?.method==="thread/start"){threadKeys.set(THREAD,"start:1");return {key:"start:1",url:threadServer.url}}
      if(!threadId)return {key:"catalog",url:catalog.url};
      const existingKey=threadKeys.get(threadId),existing=existingKey?pool.get(existingKey):null;
      if(existing&&!existing.dead&&!existing.error)return {key:existingKey,url:existing.url};
      const key="thread:"+threadId,failed=pool.get(key);
      if(failed?.error&&Date.now()-failed.failedAt<10_000)throw new Error(failed.error);
      if(!starts.has(key))starts.set(key,(async()=>{
        launches.push({at:Date.now(),method:message?.method});await new Promise(resolve=>setTimeout(resolve,300));
        if(fixture.broken)return {url:null,error:"Codex app-server profile 'Codex' exited before it was ready: the codex binary could not start",failedAt:Date.now()};
        const server=await fakeAppServer("restarted");restarted.push(server);return {url:server.url};
      })().finally(()=>starts.delete(key)));
      const server=await starts.get(key);pool.set(key,server);threadKeys.set(threadId,key);
      if(server.error)throw new Error(server.error);
      return {key,url:server.url};
    },
    // A server that died stays in the pool until it is started again (gui-server: codexAppServers.get(key)?.targetUrl===url).
    targetLive:({key,url})=>pool.get(key)?.url===url,
    // fixture.exit: what gui-server notes of a thread app-server that died (noteCodexAppServerExit), named by each resume of the thread.
    transformServerResponse:(message,{requestMethod})=>requestMethod==="thread/resume"&&fixture.exit&&message?.result?.thread?{...message,result:{...message.result,trebellAppServerExit:fixture.exit}}:message,
  });
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:process.platform,version:"app-server-death-fixture"}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
  await page.route(/\/api\/settings$/,route=>json(route,settings));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai"}]}}));
  await page.route(/\/api\/projects$/,route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON()||{};return json(route,{project:{id:"app-server-death-project",path:body.path,name:"Trebell",environmentId:null}})}return json(route,{projects:[]})});
  await page.route(/\/api\/general-workspace$/,route=>json(route,{path:process.cwd(),environmentId:null}));
  await page.route(/\/api\/stashes$/,route=>json(route,{stashes:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  // A crash of the thread's app-server: the pool still lists it, dead, until a request starts it again.
  fixture.killThreadServer=()=>{pool.get("start:1").dead=true;threadServer.kill()};
  fixture.initializes=()=>catalog.requests.filter(message=>message.method==="initialize").length;
  fixture.close=async()=>{relay.close();catalog.kill();threadServer.kill();for(const server of restarted)server.kill();await new Promise(resolve=>relayHttp.close(resolve))};
  return fixture;
}

// A General chat whose turn runs on its thread's own app-server, which then crashes.
async function runningTurn(page,fixture){
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await page.getByRole("button",{name:"Projects",exact:true}).click();
  await page.locator(".general-chat-card").click();
  await expect(page.getByTestId("composer-transport")).toHaveCount(0,{timeout:15_000});
  await page.getByTestId("composer").fill("Run the release checklist.");
  await page.getByTestId("send").click();
  await expect.poll(()=>fixture.threadServer.requests.filter(message=>message.method==="turn/start").length).toBe(1);
  await expect(page.getByRole("button",{name:/^Stop/}).first()).toBeVisible();
  fixture.killThreadServer();
}

test("a thread's own Codex app-server that dies and cannot start again stops the reconnects after three refused reopens, says why with Retry, and the turn no longer shows running",async({page})=>{
  test.setTimeout(90_000);
  const fixture=await startFixture(page);
  try{
    await runningTurn(page,fixture);
    fixture.broken=true;
    const transport=page.getByTestId("composer-transport");
    await expect(transport).toContainText("Could not connect to Codex: Codex app-server profile 'Codex' exited before it was ready: the codex binary could not start",{timeout:20_000});
    await expect(transport.getByRole("button",{name:"Retry"})).toBeVisible();
    await expect(page.getByRole("button",{name:/^Stop/})).toHaveCount(0);
    // The reconnects have stopped: none comes in the next 6 s, and Codex was launched again once.
    const connects=fixture.initializes();await page.waitForTimeout(6000);
    expect(fixture.initializes(),"no reconnect after the composer says why").toBe(connects);
    expect(fixture.launches.length,"Codex is launched again once").toBe(1);
    await page.screenshot({animations:"disabled",path:auditDir+"codex-thread-app-server-cannot-start-dark-1280x800.png"});
    // Retry connects again and reopens the thread: once Codex starts again, the thread is back, idle.
    fixture.broken=false;await page.waitForTimeout(4500);
    await transport.getByRole("button",{name:"Retry"}).click();
    await expect(transport).toHaveCount(0,{timeout:15_000});
    await expect(page.getByRole("button",{name:/^Stop/})).toHaveCount(0);
    expect(fixture.launches.length,"Retry launches Codex once more").toBe(2);
  }finally{await fixture.close()}
});

test("a thread's own Codex app-server that dies and starts again is started once, and the app reconnects to the thread",async({page})=>{
  test.setTimeout(90_000);
  const fixture=await startFixture(page);
  try{
    await runningTurn(page,fixture);
    await expect.poll(()=>fixture.restarted.length,{timeout:15_000,message:"the thread's app-server started again"}).toBe(1);
    await expect.poll(()=>fixture.restarted[0].requests.some(message=>message.method==="thread/resume"),{timeout:15_000}).toBe(true);
    await expect(page.getByTestId("composer-transport")).toHaveCount(0,{timeout:15_000});
    await expect(page.getByRole("button",{name:/^Stop/})).toHaveCount(0);
    expect(fixture.launches.length).toBe(1);
  }finally{await fixture.close()}
});

// Two listed Codex threads, each on an app-server of its own: Release (A) and Docs (B). A turn/start starts a turn (turn/started to the
// connection, then its answer) and the thread reads active until finish(threadId) ends it with turn/completed on every connection that
// resumed the thread. The pool restarts a dead thread server on the next request about its thread, as gui-server does.
const RELEASE="app-server-release-thread",DOCS="app-server-docs-thread";
async function threadServer(name){
  const http=createServer((_req,res)=>{res.writeHead(404);res.end()}),wss=new WebSocketServer({noServer:true}),sockets=new Set(),requests=[],running=new Map(),subscribers=new Map();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  const thread=(id,status)=>({id,name:id===RELEASE?"Release checklist":"Docs refresh",preview:id===RELEASE?"Release checklist":"Docs refresh",historyMode:"paginated",cwd:process.cwd(),createdAt:1_700_000_000,updatedAt:1_700_000_000,status,turns:[]});
  const subscribe=(id,ws)=>{let set=subscribers.get(id);if(!set)subscribers.set(id,set=new Set());set.add(ws)};
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>{sockets.delete(ws);for(const set of subscribers.values())set.delete(ws)});
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push(message);
      const threadId=message.params?.threadId;let result={};
      if(message.method==="initialize")result={userAgent:"app-server-"+name};
      else if(message.method==="thread/list")result={data:[thread(RELEASE,{type:"notLoaded"}),thread(DOCS,{type:"notLoaded"})],nextCursor:null};
      else if(message.method==="thread/resume"){subscribe(threadId,ws);result={thread:thread(threadId,running.has(threadId)?{type:"active",activeFlags:[]}:{type:"idle"}),itemsBackwardsCursor:null,turnsBackwardsCursor:null}}
      else if(message.method==="turn/start"){const turn={id:"turn-"+threadId,status:"inProgress",items:[]};running.set(threadId,turn);subscribe(threadId,ws);ws.send(JSON.stringify({method:"turn/started",params:{threadId,turn}}));result={turn}}
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(["thread/attachment/list","thread/queue/list","threadSection/list","thread/turns/list","thread/items/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe"){subscribers.get(threadId)?.delete(ws);result={status:"unsubscribed"}}
      else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {url:"ws://127.0.0.1:"+port,requests,
    resumes:threadId=>requests.filter(message=>message.method==="thread/resume"&&message.params?.threadId===threadId).length,
    // The thread's turn ends: turn/completed to each connection that resumed the thread (or started its turn) and is still open.
    finish(threadId){const turn=running.get(threadId);running.delete(threadId);for(const ws of subscribers.get(threadId)||[])ws.send(JSON.stringify({method:"turn/completed",params:{threadId,turn:{...turn,status:"completed"}}}))},
    kill(){for(const ws of sockets)try{ws.terminate()}catch{}try{wss.close()}catch{}try{http.close()}catch{}},
  };
}

async function twoThreadFixture(page){
  const catalog=await threadServer("catalog"),servers=new Map([[RELEASE,await threadServer("release")],[DOCS,await threadServer("docs")]]),restarted=[],starts=new Map();
  const pool=new Map([...servers].map(([threadId,server])=>["thread:"+threadId,{server}]));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachCodexRelay(relayHttp,{
    targetUrl:catalog.url,
    resolveTarget:async message=>{
      const threadId=String(message?.params?.threadId||message?.params?._trebellThreadId||"").trim();
      if(!threadId)return {key:"catalog",url:catalog.url};
      const key="thread:"+threadId,entry=pool.get(key);
      if(entry&&!entry.dead)return {key,url:entry.server.url};
      if(!starts.has(key))starts.set(key,(async()=>{await new Promise(resolve=>setTimeout(resolve,300));const server=await threadServer("restarted");restarted.push(server);pool.set(key,{server});return server})().finally(()=>starts.delete(key)));
      return {key,url:(await starts.get(key)).url};
    },
    targetLive:({key,url})=>pool.get(key)?.server.url===url,
  });
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",cwd:process.cwd(),platform:process.platform,version:"app-server-two-threads-fixture"}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
  await page.route(/\/api\/settings$/,route=>json(route,settings));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai"}]}}));
  await page.route(/\/api\/projects$/,route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON()||{};return json(route,{project:{id:"app-server-two-threads-project",path:body.path,name:"Trebell",environmentId:null}})}return json(route,{projects:[]})});
  await page.route(/\/api\/general-workspace$/,route=>json(route,{path:process.cwd(),environmentId:null}));
  await page.route(/\/api\/stashes$/,route=>json(route,{stashes:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
  // The threads' folder is this checkout: no file checkpoint is taken in it, and no context is gathered for the sends.
  await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{supported:false,reason:"not_git"}:{checkpoints:[]}));
  await page.route(/\/api\/context\/packet$/,route=>json(route,{id:"two-threads-context",skipped:true,budget:{reserveTokens:1024}}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  return {catalog,servers,restarted,
    // A crash of one thread's app-server: the pool still lists it, dead, until a request starts it again.
    kill(threadId){pool.get("thread:"+threadId).dead=true;servers.get(threadId).kill()},
    async close(){relay.close();catalog.kill();for(const server of [...servers.values(),...restarted])server.kill();await new Promise(resolve=>relayHttp.close(resolve))}};
}
const threadRow=(page,name)=>page.locator(".thread-row").filter({has:page.locator('.thread-main[title="'+name+'"]')});
async function sendIn(page,name,text){
  await threadRow(page,name).locator(".thread-main").click();
  await expect(page.locator(".workspace-shell")).toContainText(name,{timeout:15_000});
  await page.getByTestId("composer").fill(text);await page.getByTestId("send").click();
}

// One thread's app-server dies while another thread's turn runs on its own app-server. The app reconnects and reopens the thread shown;
// the other thread's turn goes on where it ran, and the app follows it again: its row still reads running, and its end reaches the app.
test("when one thread's Codex app-server dies, another thread's running turn keeps its live updates after the reconnect",async({page})=>{
  test.setTimeout(90_000);
  const fixture=await twoThreadFixture(page);
  try{
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await expect(threadRow(page,"Docs refresh")).toBeVisible({timeout:15_000});
    // Docs runs a turn, then Release is opened and runs one too; Docs keeps running beside it.
    await sendIn(page,"Docs refresh","Refresh the API docs.");
    await expect(threadRow(page,"Docs refresh").getByRole("img",{name:"Running"})).toBeVisible({timeout:15_000});
    await sendIn(page,"Release checklist","Run the release checklist.");
    await expect(threadRow(page,"Release checklist").getByRole("img",{name:"Running"})).toBeVisible({timeout:15_000});
    await expect(threadRow(page,"Docs refresh").getByRole("img",{name:"Running"})).toBeVisible();
    const docs=fixture.servers.get(DOCS),docsResumes=docs.resumes(DOCS);
    // Release's own app-server dies: the app reconnects and reopens Release on the one started in its place.
    fixture.kill(RELEASE);
    await expect.poll(()=>fixture.restarted[0]?.resumes(RELEASE)||0,{timeout:20_000,message:"Release reopened on its new app-server"}).toBeGreaterThan(0);
    await expect(page.getByTestId("composer-transport")).toHaveCount(0,{timeout:15_000});
    // Docs is followed again where its turn still runs, and its row still reads running.
    await expect.poll(()=>docs.resumes(DOCS),{timeout:15_000,message:"Docs is resumed again on its own app-server"}).toBeGreaterThan(docsResumes);
    await expect(threadRow(page,"Docs refresh").getByRole("img",{name:"Running"})).toBeVisible();
    await page.screenshot({animations:"disabled",path:SHOTS+"R4-other-thread-still-running-after-reconnect.png"});
    // Docs's turn ends on its app-server, and the app hears it.
    docs.finish(DOCS);
    await expect(threadRow(page,"Docs refresh").getByRole("img",{name:"Running"})).toHaveCount(0,{timeout:10_000});
    expect(fixture.restarted.length,"only Release's app-server was started again").toBe(1);
    await page.screenshot({animations:"disabled",path:SHOTS+"R4-other-thread-finished-after-reconnect.png"});
  }finally{await fixture.close()}
});

// The thread whose own app-server died says what happened once the app is back: how it ended, and that its turn ended with it, in one
// row, however often the app reconnects (each resume names the same death until the thread's next turn).
test("a thread's own Codex app-server that dies is named in the thread once the app reconnects, in one row however often it reconnects",async({page})=>{
  test.setTimeout(90_000);
  const fixture=await startFixture(page);
  try{
    fixture.exit={id:"exit-1",code:null,signal:"SIGKILL",at:Date.now(),turnRunning:true};
    await runningTurn(page,fixture);
    const transport=page.getByTestId("composer-transport");
    const notice=page.getByText("The Codex app-server running this thread was stopped by SIGKILL, so the turn that was running ended. Trebell started it again.",{exact:true});
    await expect.poll(()=>fixture.restarted[0]?.requests.filter(message=>message.method==="thread/resume").length||0,{timeout:20_000}).toBe(1);
    await expect(transport).toHaveCount(0,{timeout:15_000});
    await expect(notice).toHaveCount(1,{timeout:10_000});
    await expect(page.getByRole("button",{name:/^Stop/})).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:SHOTS+"R3-app-server-exit-named-after-reconnect.png"});
    // The app reconnects once more (the catalog's connections drop): the thread is reopened, and the death still reads in one row.
    const connects=fixture.initializes();fixture.catalog.drop();
    await expect.poll(()=>fixture.initializes(),{timeout:15_000}).toBeGreaterThan(connects);
    await expect.poll(()=>fixture.restarted[0].requests.filter(message=>message.method==="thread/resume").length,{timeout:15_000}).toBe(2);
    await expect(transport).toHaveCount(0,{timeout:15_000});
    await expect(notice).toHaveCount(1);
    await page.waitForTimeout(500);await expect(notice).toHaveCount(1);
    await page.screenshot({animations:"disabled",path:SHOTS+"R3-app-server-exit-once-after-second-reconnect.png"});
  }finally{await fixture.close()}
});
