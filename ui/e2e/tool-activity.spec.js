import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const shotsDir=process.env.TREBELL_E2E_SHOTS_DIR||fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(shotsDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The harness end of the agent socket, as in chat-markdown.spec.js: it answers what the window asks and pushes what the test
// sends, as the relay would while a turn runs.
async function startHarness(thread){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{sockets.add(ws);ws.on("close",()=>sockets.delete(ws));ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;let result={};
    if(message.method==="initialize")result={userAgent:"tool-activity-fixture"};
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

async function openApp(page,{harness,thread}){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  const meta={[thread.id]:{projectless:true,environmentId:null}},runtime="cursor";
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:thread.cwd,platform:process.platform,version:"tool-activity-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:meta}));
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:[thread.model],metadata:{provider:runtime,models:[{id:thread.model,name:"Fixture Model",provider:runtime,agent:"Cursor"}]}}));
  await page.route(/\/api\/thread-meta(?:\?|$)/,route=>json(route,route.request().method()==="POST"?{...meta[thread.id],...(route.request().postDataJSON()?.patch||{})}:meta[thread.id]));
  await page.route(/\/api\/checkpoints(?:\?|$)/,route=>json(route,{checkpoints:[]}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.goto("/");
  await page.getByRole("button",{name:new RegExp(thread.name)}).first().click();
  await expect(page.locator(".user-bubble").first()).toContainText(thread.turns[0].items[0].content[0].text);
}

// Trebell Native's tool calls, as the relay sends them: dynamic tool items in Native's trebell_* namespaces, with no title.
test("tool rows name what each call did, and a write that failed is renamed in place to what it attempted",async({page})=>{
  test.setTimeout(45_000);
  const thread={id:"tool-labels",name:"Tool labels fixture",preview:"Greeting",cwd:process.cwd(),model:"fixture-model",runtime:"cursor",status:{type:"idle"},createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[{id:"turn-1",status:"completed",items:[
    {type:"userMessage",id:"user-1",content:[{type:"text",text:"What does greet.py return?"}]},
    {type:"agentMessage",id:"assistant-1",text:"`greet(name)` returns `'Hello ' + name`."},
  ]}]};
  const harness=await startHarness(thread);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,thread});
    await page.getByTestId("composer").fill("Create tour-readonly.txt containing hello.");await page.getByTestId("send").click();
    await expect(page.locator(".user-bubble").last()).toContainText("Create tour-readonly.txt");
    harness.push("turn/started",{turn:{id:"turn-2",status:"inProgress",startedAt:Date.now()/1000}});
    const call=(id,tool,args)=>({type:"dynamicToolCall",id,namespace:"trebell_workspace",tool,arguments:args,status:"inProgress"});
    const start=item=>harness.push("item/started",{turnId:"turn-2",item,startedAtMs:Date.now()});
    const end=(item,status)=>harness.push("item/completed",{turnId:"turn-2",item:{...item,status,success:status==="completed"},completedAtMs:Date.now()});
    const rows=page.locator(".agent-block .tool-event"),row=title=>rows.filter({has:page.locator("summary strong").getByText(title,{exact:true})});

    const list=call("tool-list","list",{depth:2}),read=call("tool-read","read_file",{path:"greet.py"});
    start(list);end(list,"completed");start(read);end(read,"completed");
    await expect(row("Searched files").locator("summary em")).toHaveText("done");
    await expect(row("Read greet.py").locator("summary em")).toHaveText("done");

    // The rejected write: running, it reads as the write it is making; once it fails, the same row names what it attempted.
    const write=call("tool-write","write_file",{path:"tour-readonly.txt",content:"hello"});
    start(write);
    await expect(row("Wrote tour-readonly.txt").locator("summary em")).toHaveText("running");
    end(write,"failed");
    const failed=row("Write tour-readonly.txt");
    await expect(failed.locator("summary em")).toHaveText("failed");
    await expect(failed).toHaveClass(/status-error/);
    await expect(row("Wrote tour-readonly.txt")).toHaveCount(0);

    const saved=call("tool-write-notes","write_file",{path:"notes.txt",content:"hello"});
    start(saved);end(saved,"completed");
    await expect(row("Wrote notes.txt").locator("summary em")).toHaveText("done");
    await expect(rows).toHaveCount(4);

    const reply={type:"agentMessage",id:"assistant-live",text:"The workspace is read-only, so tour-readonly.txt was not created. notes.txt was written."};
    start(reply);end(reply,"completed");
    harness.push("turn/completed",{turn:{id:"turn-2",status:"completed",completedAt:Date.now()/1000}});
    await expect(page.locator(".assistant-message-text").last()).toContainText("tour-readonly.txt was not created");
    await expect(failed.locator("summary em")).toHaveText("failed");
    await expect(rows.locator("summary strong")).toHaveText(["Searched files","Read greet.py","Write tour-readonly.txt","Wrote notes.txt"]);
    await page.screenshot({path:join(shotsDir,"tool-activity-failed-write-dark-1280x800.png"),fullPage:true,animations:"disabled"});
  }finally{await harness.close()}
});
