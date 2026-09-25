import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

function makeTurns(count){
  return Array.from({length:count},(_,index)=>({
    id:"turn-"+index,status:"completed",
    items:[
      {type:"userMessage",id:"user-"+index,content:[{type:"text",text:"User message "+index+" · "+"request ".repeat(4+(index%7))}]},
      {type:"agentMessage",id:"assistant-"+index,text:"Assistant message "+index+" · "+(index===120?"needle-target · ":"")+"response ".repeat(10+(index%11))},
    ],
  }));
}

async function startHarness(thread){
  const http=createServer(),wss=new WebSocketServer({noServer:true});
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;let result={};
    if(message.method==="initialize")result={userAgent:"long-conversation-fixture"};
    else if(message.method==="thread/list")result={data:[{...thread,turns:[]}],nextCursor:null};
    else if(message.method==="threadSection/list")result={data:["Pinned","Snoozed","Settled"].map(name=>({id:name,name})),nextCursor:null};
    else if(message.method==="thread/resume")result=message.params?.excludeTurns
      ?{thread:{...thread,turns:[]},itemsBackwardsCursor:null,turnsBackwardsCursor:null}
      :{thread};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
    else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
    else if(message.method==="thread/searchOccurrences")result={data:[{itemId:"assistant-120",turnId:"turn-120",snippet:"Assistant message 120 · needle-target · response",snippetMatchRange:{start:24,end:37}}],nextCursor:null};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
    else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
    ws.send(JSON.stringify({id:message.id,result}));
  }));
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {wsUrl:"ws://127.0.0.1:"+port+"/rpc",async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

test("long conversations keep only nearby message chunks mounted",async({page})=>{
  test.setTimeout(30_000);
  const cwd=process.cwd(),now=Date.now()/1000,turns=makeTurns(300);
  const thread={id:"long-thread",name:"Long conversation stress",preview:"600 messages",cwd,model:"freebuff/test/coding-fast",status:{type:"idle"},createdAt:now-600,updatedAt:now,turns};
  const meta={[thread.id]:{projectless:true,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default",threadSnapshot:{id:thread.id,name:thread.name,preview:thread.preview,cwd,model:thread.model,createdAt:thread.createdAt,updatedAt:thread.updatedAt,status:{type:"idle"},runtime:"codex",provider:"freebuff"}}};
  const harness=await startHarness(thread);
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd,platform:process.platform,version:"long-conversation-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:meta})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({provider:"freebuff",agentRuntime:"codex",ready:true,models:[thread.model],metadata:{provider:"freebuff",agentRuntime:"codex",models:[{id:thread.model,name:"Coding Fast",agent:"Codex"}]}})}));
    await page.route(/\/api\/thread-meta(?:\?|$)/,async route=>{
      if(route.request().method()==="POST"){
        const body=route.request().postDataJSON?.()||JSON.parse(route.request().postData()||"{}");meta[body.threadId]={...(meta[body.threadId]||{}),...(body.patch||{})};
        return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(meta[body.threadId])});
      }
      const id=new URL(route.request().url()).searchParams.get("threadId");return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(meta[id]||{})});
    });
    await page.route(/\/api\/checkpoints(?:\?|$)/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({checkpoints:[]})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.route(/\/api\/freebuff\/overview/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({})}));
    await page.goto("/");
    await page.locator('.thread-main[title="Long conversation stress"]').click();

    const rows=page.locator("[data-message-id]"),chunks=page.locator("[data-virtual-chunk]");
    await expect(chunks).toHaveCount(19);
    await expect.poll(()=>rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThan(180);
    await expect(page.locator('[data-message-id="assistant-299"]')).toBeVisible();

    await page.keyboard.press(process.platform==="darwin"?"Meta+f":"Control+f");
    await expect(page.getByTestId("thread-find-input")).toBeVisible();
    await page.getByTestId("thread-find-input").fill("needle-target");
    await expect(page.locator('[data-message-id="assistant-120"]')).toBeVisible({timeout:5000});
    await expect(page.locator('[data-message-id="assistant-120"]')).toHaveClass(/find-active/);
    expect(await rows.count()).toBeLessThan(180);
    await page.getByTestId("thread-find-bar").getByRole("button",{name:"Close find"}).click();

    const scroll=page.locator(".conversation-scroll");
    await scroll.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event("scroll",{bubbles:true}))});
    await expect(page.locator('[data-message-id="user-0"]')).toBeVisible({timeout:5000});
    expect(await rows.count()).toBeLessThan(180);

    await scroll.evaluate(node=>{node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event("scroll",{bubbles:true}))});
    await expect(page.locator('[data-message-id="assistant-299"]')).toBeVisible({timeout:5000});
    expect(await rows.count()).toBeLessThan(180);

    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({path:auditDir+"long-conversation-virtualized-dark-1280x800.png",fullPage:true});
  }finally{await harness.close()}
});
