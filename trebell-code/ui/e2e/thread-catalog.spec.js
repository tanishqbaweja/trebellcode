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

async function startRuntimeHarness({currentRuntime,threadForRuntime}){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),requests=[];
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push({runtime:currentRuntime(),message});
    const thread=threadForRuntime(currentRuntime());let result={};
    if(message.method==="initialize")result={userAgent:"thread-catalog-fixture"};
    else if(message.method==="thread/list")result={data:thread?[thread]:[],nextCursor:null};
    else if(message.method==="threadSection/list")result={data:["Pinned","Snoozed","Settled"].map(name=>({id:name,name})),nextCursor:null};
    else if(message.method==="thread/resume")result={thread:message.params.threadId===thread?.id?thread:null,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
    else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
    else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
    ws.send(JSON.stringify({id:message.id,result}));
  }));
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {wsUrl:"ws://127.0.0.1:"+port+"/rpc",requests,async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

test("saved threads stay visible across runtimes and foreign rows hand off before resume",async({page})=>{
  test.setTimeout(30_000);
  let runtime="codex",runtimeSwitches=0;
  const now=Date.now()/1000,cwd=process.cwd();
  const codex={id:"catalog-codex",name:"Codex history survives",preview:"Codex task",cwd,model:"freebuff/test/coding-fast",status:{type:"idle"},createdAt:now-100,updatedAt:now-10,turns:[]};
  const claude={id:"catalog-claude",name:"Claude history survives",preview:"Claude task",cwd,model:"claude-test",runtime:"claude",status:{type:"idle"},createdAt:now-90,updatedAt:now-5,turns:[]};
  const meta={
    [codex.id]:{projectless:true,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default",threadSnapshot:{...codex,runtime:"codex",provider:"freebuff"}},
    [claude.id]:{projectless:true,environmentId:null,runtime:"claude",runtimeInstanceId:"claude-default",threadSnapshot:{...claude,runtime:"claude",provider:"claude"}},
  };
  const harness=await startRuntimeHarness({currentRuntime:()=>runtime,threadForRuntime:value=>value==="claude"?claude:codex});
  try{
    const settings=()=>({onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"});
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd,platform:process.platform,version:"thread-catalog-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:settings(),projects:[],threadMeta:meta})}));
    await page.route(/\/api\/settings$/,async route=>{
      if(route.request().method()==="GET")return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(settings())});
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(settings())});
    });
    await page.route(/\/api\/agent-runtimes$/,async route=>{
      const body=route.request().postDataJSON?.()||JSON.parse(route.request().postData()||"{}");
      if(route.request().method()==="POST"&&body.action==="select"){runtime=body.runtime;runtimeSwitches++}
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({selectedRuntime:runtime,selectedInstanceId:runtime+"-default",selected:{runtime,instance:{id:runtime+"-default"}}})});
    });
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(runtime==="claude"
      ?{provider:"freebuff",agentRuntime:"claude",ready:true,models:["claude-test"],metadata:{provider:"claude",agentRuntime:"claude",models:[{id:"claude-test",name:"Claude Test",agent:"claude"}]}}
      :{provider:"freebuff",agentRuntime:"codex",ready:true,models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",agentRuntime:"codex",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",agent:"Codex"}]}})}));
    await page.route(/\/api\/thread-meta(?:\?|$)/,async route=>{
      if(route.request().method()==="POST"){
        const body=route.request().postDataJSON?.()||JSON.parse(route.request().postData()||"{}"),id=String(body.threadId);meta[id]={...(meta[id]||{}),...(body.patch||{})};
        return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(meta[id])});
      }
      const id=new URL(route.request().url()).searchParams.get("threadId");return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(meta[id]||{})});
    });
    await page.route(/\/api\/checkpoints(?:\?|$)/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({checkpoints:[]})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.route(/\/api\/freebuff\/overview/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({})}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:300,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");

    const codexRow=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Codex history survives"]')});
    const claudeRow=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Claude history survives"]')});
    await expect(codexRow).toBeVisible();await expect(claudeRow).toBeVisible();
    await expect(claudeRow.locator(".thread-runtime-chip")).toHaveText("Claude");

    await claudeRow.locator(".thread-main").click();
    await expect.poll(()=>runtimeSwitches).toBe(1);await expect.poll(()=>runtime).toBe("claude");
    await expect(claudeRow).toHaveClass(/active/);
    await expect(codexRow).toBeVisible();
    await expect(codexRow.locator(".thread-runtime-chip")).toHaveText("Codex");
    await expect(page.locator(".sidebar-provider strong")).toContainText("Claude");
    expect(harness.requests.some(entry=>entry.runtime==="claude"&&entry.message.method==="thread/resume"&&entry.message.params?.threadId===claude.id)).toBe(true);

    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({path:auditDir+"thread-catalog-cross-runtime-dark-1280x800.png",fullPage:true});
  }finally{await harness.close()}
});
