import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const shotsDir=process.env.TREBELL_E2E_SHOTS_DIR||fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(shotsDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The harness end of the agent socket: it answers what the window asks and pushes what the test sends, as the relay (or Codex)
// would while a turn runs.
async function startHarness(thread){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{sockets.add(ws);ws.on("close",()=>sockets.delete(ws));ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;let result={};
    if(message.method==="initialize")result={userAgent:"reasoning-fixture"};
    else if(message.method==="thread/list")result={data:[{...thread,turns:[]}],nextCursor:null};
    else if(message.method==="thread/resume")result=message.params?.excludeTurns?{thread:{...thread,turns:[]}}:{thread};
    else if(message.method==="turn/start")result={turn:{id:"turn-"+(thread.turns.length+1),status:"inProgress",items:[]}};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(/\/list$/.test(message.method))result={data:[],nextCursor:null};
    ws.send(JSON.stringify({id:message.id,result}));
  })});
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",
    push(method,params){for(const ws of sockets)ws.send(JSON.stringify({method,params:{threadId:thread.id,...params}}))},
    async close(){for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
}

async function openApp(page,{harness,thread,runtime,label}){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  const meta={[thread.id]:{projectless:true,environmentId:null}};
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:thread.cwd,platform:process.platform,version:"reasoning-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:meta}));
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:[thread.model],metadata:{provider:runtime,models:[{id:thread.model,name:"Fixture Model",provider:runtime,agent:label}]}}));
  await page.route(/\/api\/thread-meta(?:\?|$)/,route=>json(route,route.request().method()==="POST"?{...meta[thread.id],...(route.request().postDataJSON()?.patch||{})}:meta[thread.id]));
  await page.route(/\/api\/checkpoints(?:\?|$)/,route=>json(route,{checkpoints:[]}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.goto("/");
  await page.getByRole("button",{name:new RegExp(thread.name)}).first().click();
  await expect(page.locator(".user-bubble").first()).toContainText(thread.turns[0].items[0].content[0].text);
}

const FIRST_TURN={id:"turn-1",status:"completed",items:[
  {type:"userMessage",id:"user-1",content:[{type:"text",text:"Find why the login handler times out."}]},
  {type:"agentMessage",id:"assistant-1",text:"I'll look into the login handler."},
]};
const THOUGHT="**Inspecting the login handler**\n\nThe timeout is 30 s in `src/auth.js`, so the slow part must be the token refresh.\nNext I will read the refresh call and time it";

test("a relay harness's thinking streams as a quiet Thinking row, opens to its text, and stays after a reload",async({page})=>{
  test.setTimeout(45_000);
  const thread={id:"reasoning-relay",name:"Reasoning relay fixture",preview:"Login timeout",cwd:process.cwd(),model:"fixture-model",runtime:"cursor",status:{type:"idle"},createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[structuredClone(FIRST_TURN)]};
  const harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,thread,runtime:"cursor",label:"Cursor"});
    await page.getByTestId("composer").fill("Keep going.");await page.getByTestId("send").click();
    await expect(page.locator(".user-bubble").last()).toContainText("Keep going.");
    harness.push("turn/started",{turn:{id:"turn-2",status:"inProgress",startedAt:Date.now()/1000}});
    const item={type:"reasoning",id:"reasoning-live",summary:[],content:[""]};
    harness.push("item/started",{turnId:"turn-2",item,startedAtMs:Date.now()});
    for(const delta of ["**Inspecting the login handler**\n\nThe timeout is 30 s in `src/auth.js`, ","so the slow part must be the token refresh.\n","Next I will read the refresh call and time it"])harness.push("item/reasoning/textDelta",{turnId:"turn-2",itemId:item.id,delta,contentIndex:0});
    const live=page.locator(".agent-block [data-testid=reasoning-row]");
    await expect(live).toHaveCount(1);
    await expect(live.locator(".reasoning-label")).toHaveText("Thinking");
    await expect(live.locator(".reasoning-preview")).toHaveText("Next I will read the refresh call and time it");
    await expect(live.getByTestId("reasoning-text")).toHaveCount(0);
    await expect(live.locator(".reasoning-toggle")).toHaveAttribute("aria-expanded","false");
    await page.screenshot({path:join(shotsDir,"reasoning-relay-streaming-collapsed-1280x800.png"),fullPage:true,animations:"disabled"});

    await live.locator(".reasoning-toggle").click();
    await expect(live.locator(".reasoning-toggle")).toHaveAttribute("aria-expanded","true");
    await expect(live.getByTestId("reasoning-text")).toHaveText(THOUGHT);
    await page.screenshot({path:join(shotsDir,"reasoning-relay-streaming-expanded-1280x800.png"),fullPage:true,animations:"disabled"});

    // The thought ends at the reply: it becomes a conversation row (still open) above the answer.
    const done={...item,content:[THOUGHT]};
    harness.push("item/completed",{turnId:"turn-2",item:done,completedAtMs:Date.now()});
    const answer={type:"agentMessage",id:"assistant-2",text:"The token refresh waits on a 30 s timeout; lowering it fixes the login.",phase:null};
    harness.push("item/agentMessage/delta",{turnId:"turn-2",delta:answer.text});
    harness.push("item/completed",{turnId:"turn-2",item:answer,completedAtMs:Date.now()});
    harness.push("turn/completed",{turn:{id:"turn-2",status:"completed",completedAt:Date.now()/1000}});
    const kept=page.locator(".conversation-history [data-testid=reasoning-row]");
    await expect(kept).toHaveCount(1);await expect(live).toHaveCount(0);
    await expect(kept.locator(".reasoning-label")).toHaveText("Thought");
    await expect(kept.getByTestId("reasoning-text")).toHaveText(THOUGHT);
    await expect(page.locator(".assistant-message-text").last()).toHaveText(answer.text);
    const order=await page.locator(".conversation-history").evaluate(node=>[...node.querySelectorAll(".user-bubble,.reasoning-row,.assistant-message-text")].map(row=>row.classList.contains("reasoning-row")?"thought":row.classList.contains("user-bubble")?"user":"answer"));
    expect(order).toEqual(["user","answer","user","thought","answer"]);
    await page.screenshot({path:join(shotsDir,"reasoning-relay-completed-1280x800.png"),fullPage:true,animations:"disabled"});

    // What the relay stored for the turn comes back on a reload: the thought is a collapsed row with its first line.
    thread.turns.push({id:"turn-2",status:"completed",items:[{type:"userMessage",id:"user-2",content:[{type:"text",text:"Keep going."}]},done,answer]});
    await page.reload();
    await page.getByRole("button",{name:/Reasoning relay fixture/}).first().click();
    const restored=page.locator(".conversation-history [data-testid=reasoning-row]");
    await expect(restored).toHaveCount(1);
    await expect(restored.locator(".reasoning-label")).toHaveText("Thought");
    await expect(restored.locator(".reasoning-preview")).toHaveText("Inspecting the login handler");
    await expect(restored.getByTestId("reasoning-text")).toHaveCount(0);
    await page.screenshot({path:join(shotsDir,"reasoning-relay-after-reload-collapsed-1280x800.png"),fullPage:true,animations:"disabled"});
    await restored.locator(".reasoning-toggle").click();
    await expect(restored.getByTestId("reasoning-text")).toHaveText(THOUGHT);
    await page.screenshot({path:join(shotsDir,"reasoning-relay-after-reload-expanded-1280x800.png"),fullPage:true,animations:"disabled"});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({path:join(shotsDir,"reasoning-relay-after-reload-expanded-light-1280x800.png"),fullPage:true,animations:"disabled"});
    const bounds=await page.locator(".conversation-scroll").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
  }finally{await harness.close()}
});

test("Codex's reasoning summary parts stream into one Thinking row and settle into the conversation",async({page})=>{
  test.setTimeout(35_000);
  const thread={id:"reasoning-codex",name:"Reasoning Codex fixture",preview:"Login timeout",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[structuredClone(FIRST_TURN)]};
  const harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,thread,runtime:"codex",label:"Codex"});
    harness.push("turn/started",{turn:{id:"turn-2",status:"inProgress",startedAt:Date.now()/1000}});
    harness.push("item/started",{turnId:"turn-2",item:{type:"reasoning",id:"rs_1",summary:[],content:[]},startedAtMs:Date.now()});
    harness.push("item/reasoning/summaryPartAdded",{turnId:"turn-2",itemId:"rs_1",summaryIndex:0});
    harness.push("item/reasoning/summaryTextDelta",{turnId:"turn-2",itemId:"rs_1",delta:"**Reading the handler**\n\nIt awaits the refresh.",summaryIndex:0});
    harness.push("item/reasoning/summaryPartAdded",{turnId:"turn-2",itemId:"rs_1",summaryIndex:1});
    harness.push("item/reasoning/summaryTextDelta",{turnId:"turn-2",itemId:"rs_1",delta:"**Timing the refresh**",summaryIndex:1});
    const live=page.locator(".agent-block [data-testid=reasoning-row]");
    await expect(live.locator(".reasoning-preview")).toHaveText("Timing the refresh");
    await live.locator(".reasoning-toggle").click();
    await expect(live.getByTestId("reasoning-text")).toHaveText("**Reading the handler**\n\nIt awaits the refresh.\n\n**Timing the refresh**");
    await page.screenshot({path:join(shotsDir,"reasoning-codex-streaming-expanded-1280x800.png"),fullPage:true,animations:"disabled"});
    // An empty encrypted-only reasoning item shows nothing once it ends.
    harness.push("item/started",{turnId:"turn-2",item:{type:"reasoning",id:"rs_empty",summary:[],content:[]},startedAtMs:Date.now()});
    harness.push("item/completed",{turnId:"turn-2",item:{type:"reasoning",id:"rs_empty",summary:[],content:[]},completedAtMs:Date.now()});
    harness.push("item/completed",{turnId:"turn-2",item:{type:"reasoning",id:"rs_1",summary:["**Reading the handler**\n\nIt awaits the refresh.","**Timing the refresh**"],content:[]},completedAtMs:Date.now()});
    const kept=page.locator(".conversation-history [data-testid=reasoning-row]");
    await expect(kept).toHaveCount(1);await expect(live).toHaveCount(0);
    await expect(kept.locator(".reasoning-label")).toHaveText("Thought");
    await expect(kept.getByTestId("reasoning-text")).toContainText("Timing the refresh");
    await kept.locator(".reasoning-toggle").click();
    await expect(kept.locator(".reasoning-preview")).toHaveText("Reading the handler");
    await page.screenshot({path:join(shotsDir,"reasoning-codex-completed-collapsed-1280x800.png"),fullPage:true,animations:"disabled"});
  }finally{await harness.close()}
});
