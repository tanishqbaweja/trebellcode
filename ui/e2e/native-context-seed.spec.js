import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { ContextEngine } from "../../src/context-engine.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

test("Native UI sends a compact repository seed instead of replaying source excerpts",async({page})=>{
  test.setTimeout(40_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-context-seed-")),home=join(root,"home"),repo=join(root,"repo");
  await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),model="model-a";
  const thread=threadStore.create({
    runtime:"native",cwd:repo,providerSessionId:"native-context-seed-session",model,
    name:"Native context seed",preview:"Compact repository context fixture",
    providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"read-only",projectless:false,environmentId:null},
  });
  const providerRequests=[];
  const nativeProviderTurn=async request=>{
    providerRequests.push(structuredClone({...request,signal:undefined}));
    return{id:"native-context-seed-reply",provider:request.provider,model:request.model,text:"Native context seed received.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});
  const relayPort=await freePort();
  await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"native-context-project",name:"Native Context Project",path:repo,environmentId:null,effectiveSettings:{}};
  let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  const instructionInjection="Repository instructions: preserve the authentication protocol and run focused tests.";
  const hugeExcerpt="VERY_LARGE_SOURCE_EXCERPT_SHOULD_NOT_REACH_NATIVE_"+("x".repeat(8000));
  const packet={
    id:"native-seed-packet",root:repo,task:"Fix refresh token session bug",generatedAt:Date.now(),tokenEstimate:2400,maxTokens:2800,
    instructionInjection,
    untrustedInjection:hugeExcerpt,
    injection:instructionInjection+"\n\n"+hugeExcerpt,
    items:[
      {path:"src/auth/session.js",score:91.2,centrality:.2,reasons:["defines task-related symbol: RefreshSession","task term match"],symbols:[{name:"RefreshSession",kind:"class",line:8}],tokenEstimate:1200},
      {path:"tests/auth-refresh.test.js",score:61.4,centrality:.08,reasons:["related test"],symbols:[{name:"refreshesExpiredSession",kind:"function",line:6}],tokenEstimate:800},
    ],
    budget:{mode:"focused",complexity:"focused",pressure:"normal",maxTokens:2800,maxFiles:12},
    stats:{filesIndexed:120,reparsed:2,reused:118,skipped:0,inspected:2,graphEdges:300,durationMs:8},
  };
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      mock:false,loggedIn:true,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,
      wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null,
    })}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"read-only",defaultWorkspaceMode:"current",followUpMode:"queue"},
      projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta},
    })}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({
      provider:"agentrouter",agentRuntime:"native",ready:true,models:[model],metadata:{provider:"agentrouter",models:[{id:model,name:"Model A",provider:"agentrouter",agent:"Trebell Native"}]},
    })}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]})}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{
      if(route.request().method()==="POST"){const body=route.request().postDataJSON();uiMeta={...uiMeta,...(body?.patch||{})}}
      await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(uiMeta)});
    });
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{id:"native-context-checkpoint",threadId:thread.id}:{checkpoints:[]})}));
    await page.route(/\/api\/checkpoints\/link$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(packet)}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native context seed"]')});
    await expect(row).toBeVisible({timeout:10_000});
    await row.locator(".thread-main").click();
    await page.getByTestId("composer").fill("Fix refresh token session bug");
    await page.getByTestId("send").click();
    await expect(page.getByText("Native context seed received.",{exact:true})).toBeVisible({timeout:10_000});
    await expect.poll(()=>providerRequests.length).toBe(1);
    const request=providerRequests[0],user=request.messages.find(item=>item.role==="user"),userText=JSON.stringify(user?.content||"");
    expect(request.messages[0]?.role).toBe("system");
    expect(String(request.messages[0]?.content||"")).toContain("You are Trebell Native");
    expect(userText).toContain(instructionInjection);
    expect(userText).toContain("Trebell repository seed");
    expect(userText).toContain("src/auth/session.js");
    expect(userText).toContain("RefreshSession");
    expect(userText).toContain("tests/auth-refresh.test.js");
    expect(userText).not.toContain("VERY_LARGE_SOURCE_EXCERPT_SHOULD_NOT_REACH_NATIVE");
    await page.setViewportSize({width:1280,height:800});
    await page.screenshot({path:auditDir+"native-context-seed-1280x800.png",fullPage:true});
  }finally{
    await relay.close();
    await new Promise(resolve=>relayServer.close(()=>resolve()));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
