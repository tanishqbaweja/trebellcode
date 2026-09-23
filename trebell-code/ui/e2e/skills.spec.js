import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("Codex skills expose disabled entries, persistent toggles and runtime extra roots",async({page})=>{
  test.setTimeout(35_000);
  const thread={id:"skills-fixture",name:"Skills fixture",preview:"Native skill controls",cwd:process.cwd(),createdAt:Date.now()-1000,updatedAt:Date.now(),turns:[]};
  const alphaPath="/home/test/.codex/skills/alpha/SKILL.md",betaPath="/home/test/.codex/skills/beta/SKILL.md";
  let alphaEnabled=true,betaEnabled=false,extraRoots=[];const calls=[];
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      const respond=value=>ws.send(JSON.stringify({id:message.id,result:value}));
      if(message.method==="initialize")result={userAgent:"skills-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="threadSection/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/resume"||message.method==="thread/read")result={thread};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list"||message.method==="thread/items/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="skills/list")result={data:[{cwd:process.cwd(),skills:[
        {name:"alpha",description:"Alpha workspace helper",path:alphaPath,scope:"user",enabled:alphaEnabled,pluginId:null,interface:{displayName:"Alpha helper",shortDescription:"Enabled helper"}},
        {name:"beta",description:"Beta workspace helper",path:betaPath,scope:"repo",enabled:betaEnabled,pluginId:null,interface:{displayName:"Beta helper",shortDescription:"Disabled helper"}},
        ...(extraRoots.length?[{name:"extra-root",description:"Runtime root skill",path:extraRoots[0]+"/SKILL.md",scope:"user",enabled:true,pluginId:null}]:[]),
      ],errors:[]}]};
      else if(message.method==="skills/config/write"){
        if(message.params.path===alphaPath)alphaEnabled=message.params.enabled;
        if(message.params.path===betaPath)betaEnabled=message.params.enabled;
        respond({effectiveEnabled:message.params.enabled});return;
      }else if(message.method==="skills/extraRoots/set"){
        extraRoots=message.params.extraRoots||[];respond({});setTimeout(()=>ws.send(JSON.stringify({method:"skills/changed",params:{}})),0);return;
      }else if(message.method==="permissionProfile/list"||message.method==="mcpServerStatus/list"||message.method==="app/list"||message.method==="hooks/list"||message.method==="experimentalFeature/list"||message.method==="plugin/share/list")result={data:[]};
      else if(message.method==="plugin/list")result={marketplaces:[]};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      else if(message.method==="account/read")result={account:null,requiresOpenaiAuth:false};
      else if(message.method==="account/rateLimits/read")result={rateLimits:{}};
      else if(message.method==="account/usage/read")result={};
      else if(message.method==="config/read")result={config:{},layers:[]};
      else if(message.method==="configRequirements/read")result={requirements:{}};
      else if(message.method==="memory/status")result={v2ConsolidatedThreads:20,v2Ready:true};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      respond(result);
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamPort}`});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/codex/ws`,cwd:process.cwd(),platform:"linux",version:"skills-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"freebuff",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["freebuff/test/coding-fast"],metadata:{provider:"freebuff",models:[{id:"freebuff/test/coding-fast",name:"Coding Fast",provider:"freebuff",agent:"Codex"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");await page.getByRole("button",{name:/Skills fixture/}).click();await page.getByRole("button",{name:"Tools",exact:true}).click();
    const card=page.locator(".capability-card").filter({hasText:"Skills"});await expect(card).toContainText("Alpha helper");await expect(card).toContainText("Beta helper");
    const alpha=card.locator(".skill-list>div").filter({hasText:"Alpha helper"});const beta=card.locator(".skill-list>div").filter({hasText:"Beta helper"});
    await expect(alpha.getByRole("button",{name:"On"})).toBeVisible();await expect(beta.getByRole("button",{name:"Off"})).toBeVisible();
    await beta.getByRole("button",{name:"Off"}).click();await expect(beta.getByRole("button",{name:"On"})).toBeVisible();
    const toggleCall=calls.find(call=>call.method==="skills/config/write"&&call.params?.path===betaPath);expect(toggleCall?.params).toEqual({path:betaPath,name:null,enabled:true});
    await expect(card).toContainText(/saved in Codex config/i);
    const roots=card.locator(".skill-roots-editor textarea");await roots.fill("/tmp/trebell-skills\n/opt/shared-skills\n/tmp/trebell-skills");await card.getByRole("button",{name:"Apply runtime roots"}).click();
    await expect(card).toContainText("2 runtime skill roots applied");
    const rootsCall=calls.find(call=>call.method==="skills/extraRoots/set");expect(rootsCall?.params).toEqual({extraRoots:["/tmp/trebell-skills","/opt/shared-skills"]});
    await expect(card).toContainText("extra-root");
    await page.screenshot({path:auditDir+"tools-skills-managed-1600x980.png",fullPage:true});
    await page.setViewportSize({width:1280,height:800});const overflow=await card.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(overflow.scroll).toBeLessThanOrEqual(overflow.client+1);await page.screenshot({path:auditDir+"tools-skills-managed-1280x800.png",fullPage:true});
  }finally{relay.close();for(const socket of sockets)try{socket.terminate()}catch{}upstreamWss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])}
});
