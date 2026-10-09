import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

// A Codex-protocol harness whose transport can drop and refuse new connections for a while, like an app-server restart.
async function startHarness(){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set(),requests=[];let accepting=true,connections=0;
  http.on("upgrade",(req,socket,head)=>{if(!accepting){socket.destroy();return}wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req))});
  wss.on("connection",ws=>{
    connections++;sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push(message);
      let result={};
      if(message.method==="initialize")result={userAgent:"harness-reconnect-fixture"};
      else if(message.method==="thread/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/start")result={thread:{id:"reconnect-thread",name:"Reconnect fixture",cwd:process.cwd(),createdAt:Date.now()/1000,updatedAt:Date.now()/1000,turns:[]}};
      else if(message.method==="turn/start")result={turn:{id:"reconnect-turn",status:"inProgress",items:[]}};
      else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+port,requests,connections:()=>connections,
    drop(){accepting=false;for(const ws of sockets)ws.terminate()},
    accept(){accepting=true},
    async close(){accepting=false;for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
}

test("a send while the harness transport is down keeps the draft, never falls back to the Native provider and works once reconnected",async({page})=>{
  test.setTimeout(45_000);
  const harness=await startHarness();let directCalls=0;
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  try{
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"harness-reconnect-fixture"}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{}}));
    await page.route(/\/api\/settings$/,route=>json(route,settings));
    await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai"}]}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/general-workspace$/,route=>json(route,{path:process.cwd(),environmentId:null}));
    await page.route(/\/api\/stashes$/,route=>json(route,{stashes:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.route(/\/api\/chat\/direct$/,route=>{directCalls++;return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"The direct route must not be used outside mock mode"})})});
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    await page.getByRole("button",{name:"Projects",exact:true}).click();
    await page.locator(".general-chat-card").click();
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),transport=page.getByTestId("composer-transport");
    await expect(page.locator(".composer-status")).toContainText("Ctrl/Cmd+Enter background");
    await expect(transport).toHaveCount(0);
    expect(harness.connections()).toBe(1);

    harness.drop();
    await expect(transport).toContainText("Reconnecting to Codex");
    const draft="Keep this draft while Codex reconnects.";
    await composer.fill(draft);
    await expect(composer).toBeEditable();
    await expect(send).toBeDisabled();
    await expect(send).toHaveAttribute("title","Reconnecting to Codex…");
    await composer.press("Enter");
    await expect(page.getByText("Codex is reconnecting. Your draft was kept; send it again once Codex is connected.")).toBeVisible();
    await expect(composer).toHaveValue(draft);
    expect(directCalls).toBe(0);
    expect(harness.requests.some(message=>message.method==="thread/start"||message.method==="turn/start")).toBe(false);
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({path:auditDir+"harness-reconnecting-keeps-draft-1280x800.png",fullPage:true});

    harness.accept();
    await expect(transport).toHaveCount(0,{timeout:15_000});
    expect(harness.connections()).toBe(2);
    await expect(composer).toHaveValue(draft);
    await expect(send).toBeEnabled();
    await send.click();
    await expect.poll(()=>harness.requests.filter(message=>message.method==="turn/start").length).toBe(1);
    expect(JSON.stringify(harness.requests.find(message=>message.method==="turn/start").params)).toContain(draft);
    await expect(composer).toHaveValue("");
    expect(directCalls).toBe(0);
  }finally{await harness.close()}
});
