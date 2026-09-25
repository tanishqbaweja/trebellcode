import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

function toolEntry(index){
  return {type:"item",turnId:"turn-long",item:{type:"commandExecution",id:"tool-"+index,command:["echo",String(index)],status:"completed",aggregatedOutput:"ok "+index}};
}

function timelinePage(cursor){
  if(cursor==="p2")return {data:Array.from({length:100},(_,i)=>toolEntry(100+i)),nextCursor:"p3"};
  if(cursor==="p3")return {data:Array.from({length:99},(_,i)=>toolEntry(1+i)),nextCursor:"p4"};
  if(cursor==="p4")return {data:[{type:"turnStarted",turnId:"turn-long"},toolEntry(0)],nextCursor:null};
  return {data:Array.from({length:100},(_,i)=>toolEntry(200+i)),nextCursor:"p2"};
}

async function startHarness(thread){
  const http=createServer(),wss=new WebSocketServer({noServer:true});
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;let result={};
    if(message.method==="initialize")result={userAgent:"activity-window-fixture"};
    else if(message.method==="thread/list")result={data:[{...thread,turns:[]}],nextCursor:null};
    else if(message.method==="threadSection/list")result={data:["Pinned","Snoozed","Settled"].map(name=>({id:name,name})),nextCursor:null};
    else if(message.method==="thread/resume")result=message.params?.excludeTurns?{thread:{...thread,turns:[]}}:{thread};
    else if(message.method==="thread/timeline/list")result=timelinePage(message.params?.cursor||null);
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
    ws.send(JSON.stringify({id:message.id,result}));
  }));
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {wsUrl:"ws://127.0.0.1:"+port+"/rpc",async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

test("large restored activity traces mount one bounded page at a time",async({page})=>{
  test.setTimeout(30_000);
  const cwd=process.cwd(),now=Date.now()/1000;
  const thread={id:"activity-thread",name:"Large activity trace",preview:"300 tools",cwd,model:"freebuff/test/coding-fast",status:{type:"idle"},createdAt:now-100,updatedAt:now,turns:[{id:"turn-long",status:"completed",items:[
    {type:"userMessage",id:"user-long",content:[{type:"text",text:"Run a long deterministic tool workflow."}]},
    {type:"agentMessage",id:"assistant-long",text:"Workflow complete."},
  ]}]};
  const meta={[thread.id]:{projectless:true,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default",threadSnapshot:{id:thread.id,name:thread.name,preview:thread.preview,cwd,model:thread.model,createdAt:thread.createdAt,updatedAt:thread.updatedAt,status:{type:"idle"},runtime:"codex",provider:"freebuff"}}};
  const harness=await startHarness(thread);
  try{
    const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd,platform:process.platform,version:"activity-window-fixture"}));
    await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:meta}));
    await page.route(/\/api\/models$/,route=>json(route,{provider:"freebuff",agentRuntime:"codex",ready:true,models:[thread.model],metadata:{provider:"freebuff",agentRuntime:"codex",models:[{id:thread.model,name:"Coding Fast",agent:"Codex"}]}}));
    await page.route(/\/api\/thread-meta(?:\?|$)/,async route=>{
      if(route.request().method()==="POST"){const body=route.request().postDataJSON();meta[body.threadId]={...(meta[body.threadId]||{}),...(body.patch||{})};return json(route,meta[body.threadId])}
      return json(route,meta[new URL(route.request().url()).searchParams.get("threadId")]||{});
    });
    await page.route(/\/api\/checkpoints(?:\?|$)/,route=>json(route,{checkpoints:[]}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.route(/\/api\/freebuff\/overview/,route=>json(route,{}));
    await page.goto("/");
    await page.locator('.thread-main[title="Large activity trace"]').click();

    const rows=page.locator(".tool-event"),controls=page.locator(".timeline-window-controls");
    await expect(controls).toContainText("181–300 of 300",{timeout:5000});
    await expect(rows).toHaveCount(120);
    await expect(page.getByText("echo 299",{exact:true})).toBeAttached();
    await expect(page.getByText("echo 0",{exact:true})).toHaveCount(0);

    await controls.getByRole("button",{name:"Earlier"}).click();
    await expect(controls).toContainText("61–180 of 300");
    await expect(rows).toHaveCount(120);
    await controls.getByRole("button",{name:"Earlier"}).click();
    await expect(controls).toContainText("1–60 of 300");
    await expect(rows).toHaveCount(60);
    await expect(page.getByText("echo 0",{exact:true})).toBeAttached();

    await controls.getByRole("button",{name:"Latest"}).click();
    await expect(controls).toContainText("181–300 of 300");
    await expect(rows).toHaveCount(120);
    await controls.scrollIntoViewIfNeeded();
    await page.screenshot({path:"visual-audit/large-activity-window-dark-1280x800.png",fullPage:true});
  }finally{await harness.close()}
});
