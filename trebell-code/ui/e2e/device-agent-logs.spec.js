import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

async function fakeAppServer(thread){
  const http=createServer(),wss=new WebSocketServer({server:http}),sockets=new Set(),pending=new Map();let active=null,nextId=9000;
  wss.on("connection",ws=>{
    sockets.add(ws);active=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));
      if(message.id!=null&&!message.method){const waiter=pending.get(String(message.id));if(waiter){pending.delete(String(message.id));clearTimeout(waiter.timer);waiter.resolve(message)}return}
      if(message.id==null||!message.method)return;
      let result={};
      if(message.method==="initialize")result={userAgent:"device-agent-logs-fixture"};
      else if(message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  await new Promise((resolve,reject)=>http.listen(0,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+http.address().port,
    request(method,params={}){
      if(!active)throw new Error("Renderer is not connected to the fake app-server.");
      const id=nextId++;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(String(id));reject(new Error("Timed out waiting for renderer response to "+method))},5000);
        pending.set(String(id),{resolve,reject,timer});active.send(JSON.stringify({id,method,params}));
      });
    },
    async close(){
      for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error("Fixture closed"))}pending.clear();
      for(const ws of sockets)try{ws.terminate()}catch{}
      await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>http.close(resolve));
    },
  };
}

test("agent device logs route through the bounded simulator-log API as untrusted read data",async({page})=>{
  const root=process.cwd(),project={id:"device-agent-project",name:"Device agent fixture",path:root,environmentId:null,effectiveSettings:{defaultWorkspaceMode:"current",agentDeviceAccess:true}};
  const thread={id:"device-agent-thread",name:"Device agent fixture",preview:"Agent simulator log validation",cwd:root,createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  const harness=await fakeAppServer(thread);let requestedUrl="";
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",activeProjectId:project.id};
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:root,platform:process.platform,version:"device-agent-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[project],threadMeta:{[thread.id]:{projectless:false,cwd:root,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[project],project})}));
    await page.route(/\/api\/thread-meta$/,route=>{const body=route.request().postDataJSON?.()||{};return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body.patch||{})})});
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.route(/\/api\/device\/logs\?/,route=>{requestedUrl=route.request().url();return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"android:emulator-5554",platform:"android",text:"I/Trebell: bounded device log",lineCount:1,omittedLines:0,omittedCharacters:0,truncated:false})})});
    await page.goto("/");
    await page.getByRole("button",{name:/Device agent fixture/}).click();
    await expect(page.locator(".thread-row.active")).toContainText("Device agent fixture");

    const response=await harness.request("item/tool/call",{threadId:thread.id,namespace:"trebell_device",tool:"logs",arguments:{id:"android:emulator-5554",lines:75,minutes:3}});
    expect(response.result?.success).toBe(true);
    expect(response.result.contentItems[0].text).toContain("untrusted external tool data");
    const payload=JSON.parse(response.result.contentItems.find(item=>item.text?.startsWith("{"))?.text||"{}");
    expect(payload.text).toContain("bounded device log");expect(payload.lineCount).toBe(1);
    expect(requestedUrl).toContain("lines=75");expect(requestedUrl).toContain("minutes=3");
  }finally{await harness.close()}
});
