import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createGuiServer } from "../../src/gui-server.mjs";
import { e2eHome } from "./test-home.js";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// A Codex app-server that answers what the app asks for at start and on the Usage page; notify() sends a notification to every
// connection, as Codex sends a thread's events to each window that shows it.
async function fakeCodexAppServer(){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;let result={};
      if(message.method==="initialize")result={userAgent:"codex-turn-usage-fixture"};
      else if(["thread/list","threadSection/list","skills/list","thread/loaded/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(message.method==="account/read")result={account:{type:"chatgpt",email:"usage@example.com",planType:"plus"},requiresOpenaiAuth:false};
      else if(message.method==="account/rateLimits/read")result={rateLimits:{limitId:"main",limitName:"Coding quota",primary:{usedPercent:20,resetsAt:Math.floor(Date.now()/1000)+3600}}};
      else if(message.method==="account/usage/read")result={summary:{lifetimeTokens:1_250_000,currentStreakDays:3,peakDailyTokens:180_000,longestRunningTurnSec:95},threadUsage:null};
      else if(message.method==="account/workspaceMessages/read")result={featureEnabled:false,messages:[]};
      else if(["experimentalFeature/list","permissionProfile/list","mcpServerStatus/list","app/list","hooks/list","plugin/share/list","collaborationMode/list"].includes(message.method))result={data:[]};
      else if(message.method==="config/read")result={config:{},layers:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {port,connections:()=>sockets.size,notify(method,params){for(const ws of sockets)ws.send(JSON.stringify({method,params}))},async close(){for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

// Codex's thread/tokenUsage/updated: total is the thread's running total, last the newest model request's usage.
const FIELDS=["totalTokens","inputTokens","cachedInputTokens","cacheWriteInputTokens","outputTokens","reasoningOutputTokens"];
const request=(input,output,{cached=0,write=0,reasoning=0}={})=>({totalTokens:input+output,inputTokens:input,cachedInputTokens:cached,cacheWriteInputTokens:write,outputTokens:output,reasoningOutputTokens:reasoning});
const add=(...items)=>Object.fromEntries(FIELDS.map(key=>[key,items.reduce((sum,item)=>sum+(item[key]||0),0)]));

test("The Usage page counts every model request of a Codex turn that called tools",async({page})=>{
  test.setTimeout(60_000);
  // The app talks to a Trebell server of this test's own, whose Codex relay reaches the fake Codex: the turn's usage is what that
  // server records from Codex's updates, and the Usage page reads it from there.
  const codex=await fakeCodexAppServer(),home=await mkdtemp(join(e2eHome(),"codex-turn-usage-")),port=await freePort();
  const gui=await createGuiServer({port,appPort:codex.port,mock:true,env:{...process.env,TREBELL_HOME:join(home,"home"),CODEX_HOME:join(home,"codex-home"),CLAUDE_CONFIG_DIR:join(home,"claude-config"),OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:"",HARBOR_TELEMETRY:"0"}});
  const threadId="codex-turn-usage-thread",turnId="codex-turn-usage-turn";
  const serverRecord=async()=>(await fetch(gui.url+"/api/usage?days=1").then(response=>response.json())).records.find(item=>item.turnId===turnId)||null;
  try{
    const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:gui.url.replace(/^http/,"ws")+"/api/codex/ws",cwd:process.cwd(),platform:"win32",version:"codex-turn-usage",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}}));
    await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.route(/\/api\/environments$/,route=>json(route,{profiles:[],activeEnvironmentId:null,activeEnvironment:null}));
    // The page's usage comes from the test's server, as the app's own server answers it.
    await page.route(/\/api\/usage(?:\?.*)?$/,async route=>{const url=new URL(route.request().url());const answer=await fetch(gui.url+url.pathname+url.search,{method:route.request().method()});await route.fulfill({status:answer.status,contentType:"application/json",body:await answer.text()})});
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await expect.poll(()=>codex.connections()).toBeGreaterThan(0);

    // A Codex turn that read a file, ran the tests and edited a file: a model request after each tool, each counted in the
    // thread's running total, which also holds the thread's earlier turns.
    const earlier=request(60_000,7_000,{cached:50_000}),r1=request(12_000,500,{cached:11_000}),r2=request(12_600,900,{cached:12_000,reasoning:300}),r3=request(13_300,1_400,{cached:12_500,write:400});
    const tokenUsage=(total,last)=>codex.notify("thread/tokenUsage/updated",{threadId,turnId,tokenUsage:{total,last,modelContextWindow:200_000}});
    codex.notify("thread/tokenUsage/updated",{threadId,turnId:"codex-turn-usage-earlier",tokenUsage:{total:earlier,last:earlier,modelContextWindow:200_000}});
    codex.notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress",items:[]}});
    tokenUsage(add(earlier,r1),r1);tokenUsage(add(earlier,r1,r2),r2);tokenUsage(add(earlier,r1,r2,r3),r3);
    codex.notify("turn/completed",{threadId,turn:{id:turnId,status:"completed",items:[]}});
    // The server has taken every update once its record stops changing.
    let previous=null;
    await expect.poll(async()=>{const record=await serverRecord(),value=record?JSON.stringify(record.usage):null,settled=Boolean(value)&&value===previous;previous=value;return settled},{intervals:[250]}).toBe(true);

    await page.getByRole("button",{name:"Usage",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Usage",level:2})).toBeVisible();
    const summary=page.locator(".usage-summary"),turn=add(r1,r2,r3);
    // 40.7K tokens over three requests, where recording each request in turn had left the last one's 14.7K.
    await expect(summary.locator("div").filter({hasText:"Total tokens"})).toContainText("40.7K");
    await expect(summary).toContainText("1 recorded turn");
    await expect(summary.locator("div").filter({hasText:"Input"})).toContainText("37.9K");
    await expect(summary).toContainText("35.5K cache read · 400 cache write");
    await expect(summary.locator("div").filter({hasText:"Output"})).toContainText("2.8K");
    await expect(summary).toContainText("300 reasoning");
    const row=page.locator(".usage-recent .usage-table > div").filter({hasText:"Codex"});
    await expect(row).toHaveCount(1);await expect(row).toContainText("40.7K");
    expect((await serverRecord()).usage).toEqual(turn);
    const metrics=await page.locator(".usage-page").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await summary.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:auditDir+"codex-turn-usage-1280x800.png",fullPage:false});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await page.screenshot({animations:"disabled",path:auditDir+"codex-turn-usage-light-1280x800.png",fullPage:false});
  }finally{
    await page.close().catch(()=>{});await gui.close();await codex.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250}).catch(()=>{});
  }
});
