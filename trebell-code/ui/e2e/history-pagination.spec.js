import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

function turn(index){
  const padding=`Message ${index} `+"history ".repeat(34);
  return {id:`turn-${index}`,status:"completed",items:[
    {id:`user-${index}`,type:"userMessage",content:[{type:"inputText",text:`User ${padding}`}]},
    {id:`assistant-${index}`,type:"agentMessage",text:`Assistant ${padding}`},
  ]};
}

test("Codex thread history opens from a bounded page and loads older turns on demand",async({page})=>{
  test.setTimeout(35_000);
  const thread={id:"history-page-fixture",name:"Paginated history fixture",preview:"Bounded Codex history",cwd:process.cwd(),createdAt:Date.now()-1000,updatedAt:Date.now(),turns:[]};
  const legacyThread={id:"history-legacy-fixture",name:"Legacy history fixture",preview:"Fallback full history",cwd:process.cwd(),createdAt:Date.now()-2000,updatedAt:Date.now()-500,turns:[]};
  const latest=Array.from({length:10},(_,index)=>turn(index+11)).reverse();
  const older=Array.from({length:10},(_,index)=>turn(index+1)).reverse();
  const calls=[];
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"history-fixture"};
      else if(message.method==="thread/list")result={data:[thread,legacyThread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume"){
        if(message.params.threadId===legacyThread.id)result=message.params.excludeTurns===false?{thread:{...legacyThread,turns:[turn(99)]}}:{thread:legacyThread};
        else result={thread,initialTurnsPage:{data:latest,nextCursor:"older-page",backwardsCursor:"latest-anchor"}};
      }
      else if(message.method==="thread/turns/list")result={data:message.params.cursor==="older-page"?older:[],nextCursor:null,backwardsCursor:"older-anchor"};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/items/list")result={data:[],nextCursor:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamPort}`});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/codex/ws`,cwd:process.cwd(),platform:process.platform,version:"history-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null},[legacyThread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");await page.getByRole("button",{name:/Paginated history fixture/}).click();
    await expect(page.getByText(/User Message 11 history/)).toBeVisible();await expect(page.getByText(/Assistant Message 20 history/)).toBeVisible();
    await expect(page.getByText(/User Message 1 history/)).toHaveCount(0);
    const resumeCall=calls.find(call=>call.method==="thread/resume");
    expect(resumeCall?.params?.excludeTurns).toBe(true);expect(resumeCall?.params?.initialTurnsPage).toEqual({limit:40,sortDirection:"desc",itemsView:"full"});
    expect(calls.some(call=>call.method==="thread/turns/list")).toBe(false);
    const scroller=page.locator(".conversation-scroll");await scroller.evaluate(node=>{node.scrollTop=0});
    await page.screenshot({path:auditDir+"chat-paginated-history-1600x980.png",fullPage:true});
    const before=await scroller.evaluate(node=>({top:node.scrollTop,height:node.scrollHeight}));
    await page.getByRole("button",{name:"Load earlier messages"}).click();
    await expect(page.getByText(/User Message 1 history/)).toBeVisible();await expect(page.getByRole("button",{name:"Load earlier messages"})).toHaveCount(0);
    const turnsCall=calls.find(call=>call.method==="thread/turns/list");expect(turnsCall?.params).toEqual({threadId:thread.id,cursor:"older-page",limit:40,sortDirection:"desc",itemsView:"full"});
    const after=await scroller.evaluate(node=>({top:node.scrollTop,height:node.scrollHeight}));
    expect(after.height).toBeGreaterThan(before.height);expect(after.top).toBeGreaterThan(0);expect(Math.abs(after.top-(after.height-before.height))).toBeLessThan(80);
    await page.setViewportSize({width:1280,height:800});await page.screenshot({path:auditDir+"chat-paginated-history-loaded-1280x800.png",fullPage:true});

    await page.getByRole("button",{name:/Legacy history fixture/}).click();
    await expect(page.getByText(/User Message 99 history/)).toBeVisible();
    const legacyResumes=calls.filter(call=>call.method==="thread/resume"&&call.params?.threadId===legacyThread.id);
    expect(legacyResumes).toHaveLength(2);expect(legacyResumes[0].params.excludeTurns).toBe(true);expect(legacyResumes[1].params.excludeTurns).toBe(false);
    await expect(page.getByRole("button",{name:"Load earlier messages"})).toHaveCount(0);
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});
