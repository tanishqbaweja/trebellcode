import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// A Codex app-server that lists one delegated child agent in the given state, behind the real relay.
async function startFleetFixture(status){
  const child={id:"fleet-child",parentThreadId:"fleet-parent",name:"Fleet fixture agent",preview:"Fleet chip fixture",agentRole:"researcher",status:{type:status},model:"test/coding-fast",cwd:process.cwd(),createdAt:Date.now()/1000-10,updatedAt:Date.now()/1000,turns:[]};
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;let result={};
      if(message.method==="initialize")result={userAgent:"fleet-fixture"};
      else if(message.method==="thread/list")result={data:[child],nextCursor:null};
      else if(["threadSection/list","thread/loaded/list","thread/attachment/list","thread/queue/list","app/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(message.method==="collaborationMode/list"||message.method==="skills/list")result={data:[]};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",
    async close(){relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])},
  };
}

async function openAgents(page,fixture){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:fixture.wsUrl,cwd:process.cwd(),platform:"linux",version:"fleet-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{}}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.setViewportSize({width:1600,height:980});
  await page.goto("/");
  await page.locator('.sidebar .sidebar-utility[aria-label="Agents"]').click();
  const agents=page.locator(".agents-page");
  await expect(agents).toContainText("Fleet fixture agent");
  return agents;
}

// The chip's text color, beside what the accent token resolves to in the current mode.
const chipColors=agents=>agents.evaluate(node=>{
  const color=element=>getComputedStyle(element).color,chips=[...node.querySelectorAll(".agent-fleet-stats span")];
  const probe=document.createElement("span");probe.style.color="var(--ac)";node.appendChild(probe);const accent=color(probe);probe.remove();
  return {accent,working:color(chips.find(chip=>/working$/.test(chip.textContent))),sleeping:color(chips.find(chip=>/sleeping$/.test(chip.textContent)))};
});

test("the fleet working chip stays neutral while no agent works",async({page})=>{
  test.setTimeout(30_000);
  const fixture=await startFleetFixture("idle");
  try{
    const agents=await openAgents(page,fixture);
    const working=agents.locator(".agent-fleet-stats span").filter({hasText:/working$/});
    await expect(working).toHaveText("0 working");
    await expect(working).not.toHaveClass(/\bworking\b/);
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
      const colors=await chipColors(agents);
      // Zero working reads like the other neutral counts, not in the accent that marks live work.
      expect(colors.working,mode).toBe(colors.sleeping);expect(colors.working,mode).not.toBe(colors.accent);
      await page.screenshot({animations:"disabled",path:auditDir+`agents-fleet-idle-${mode}-1600x980.png`});
    }
  }finally{await fixture.close()}
});

test("the fleet working chip takes the accent while an agent works",async({page})=>{
  test.setTimeout(30_000);
  const fixture=await startFleetFixture("active");
  try{
    const agents=await openAgents(page,fixture);
    const working=agents.locator(".agent-fleet-stats span").filter({hasText:/working$/});
    await expect(working).toHaveText("1 working");
    await expect(working).toHaveClass(/\bworking\b/);
    const colors=await chipColors(agents);
    expect(colors.working).toBe(colors.accent);
    await page.screenshot({animations:"disabled",path:auditDir+"agents-fleet-working-dark-1600x980.png"});
  }finally{await fixture.close()}
});
