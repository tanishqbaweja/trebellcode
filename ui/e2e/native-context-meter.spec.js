import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { ContextEngine } from "../../src/context-engine.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";

// The composer's Context reads the context in use: the input of the turn's last request, as it does when the model's window is
// known, not every request of the turn summed. A Native turn on Meta (whose window Trebell does not know) of two requests, a file
// read and the reply, as the tour's six-request turn read "Context 45,708 tokens" for a last request of 8,422 (tour L10-3). The
// turn's total stays in the meter's title. No live model is called: the relay's Native provider is a stand-in.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const FIRST={totalTokens:6100,inputTokens:6000,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:100,reasoningOutputTokens:0};
const LAST={totalTokens:8442,inputTokens:8422,cachedInputTokens:6000,cacheWriteInputTokens:0,outputTokens:20,reasoningOutputTokens:0};
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

for(const mode of ["dark","light"])test(`after a Native turn of two requests the composer's Context reads the last request's input, the turn's total in its title (${mode})`,async({page})=>{
  test.setTimeout(60_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-context-meter-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await writeFile(join(repo,"notes.txt"),"tide tables\n");
  const model="muse-spark-1.3-contributor";
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"meta",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"context-meter-session",model,name:"Context meter",preview:"Native turn on Meta",
    providerMeta:{runtimeInstanceId:"native-default",modelProvider:"meta",permissionProfile:"read-only",projectless:false,environmentId:null}});
  let coding=0;
  const nativeProviderTurn=async request=>{
    if(request.metadata?.completionGate||request.responseJsonSchema?.name==="trebell_completion_gate")return {id:"context-meter-gate",provider:request.provider,model:request.model,text:JSON.stringify({status:"complete",progress:"uncertain",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"The reply answers the question."}),toolCalls:[],finishReason:"stop",usage:{}};
    coding++;
    if(coding===1)return {id:"context-meter-read",provider:request.provider,model:request.model,text:"",toolCalls:[{id:"context-meter-tool-1",namespace:"trebell_workspace",name:"read_file",arguments:JSON.stringify({path:"notes.txt"})}],finishReason:"tool_calls",usage:{...FIRST}};
    return {id:"context-meter-reply",provider:request.provider,model:request.model,text:"The notes are about tide tables.",toolCalls:[],finishReason:"stop",usage:{...LAST}};
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"context-meter-project",name:"Context Meter",path:repo,environmentId:null,effectiveSettings:{}};
  let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  const json=body=>({status:200,contentType:"application/json",body:JSON.stringify(body)});
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill(json({mock:false,provider:"meta",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})));
    await page.route(/\/api\/state$/,route=>route.fulfill(json({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:mode,panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"meta",defaultPermissionMode:"read-only",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}})));
    await page.route(/\/api\/models$/,route=>route.fulfill(json({provider:"meta",agentRuntime:"native",ready:true,models:[model],metadata:{provider:"meta",models:[{id:model,name:"Muse Spark 1.3 Contributor",provider:"meta",agent:"Trebell Native"}]}})));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill(json(route.request().method()==="POST"?{project}:{projects:[project]})));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill(json({ok:true})));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill(json({isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]})));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();uiMeta={...uiMeta,...(body?.patch||{})}}await route.fulfill(json(uiMeta))});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill(json(route.request().method()==="POST"?{id:"context-meter-checkpoint",threadId:thread.id}:{checkpoints:[]})));
    await page.route(/\/api\/checkpoints\/link$/,route=>route.fulfill(json({ok:true})));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill(json({id:"context-meter-packet",root:repo,task:"",generatedAt:Date.now(),tokenEstimate:0,maxTokens:0,injection:"",items:[],budget:{},stats:{}})));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill(json({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})));
    await page.route(/\/api\/environments$/,route=>route.fulfill(json({profiles:[],activeEnvironmentId:null,activeEnvironment:null})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Context meter"]')});
    await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();
    await page.getByTestId("composer").fill("What are the notes about?");
    await page.getByTestId("send").click();
    await expect(page.getByText("The notes are about tide tables.",{exact:true})).toBeVisible({timeout:15_000});
    expect(coding,"the turn's coding requests").toBe(2);
    const context=page.locator(".composer-context");
    await expect(context).toContainText("Context 8,422 tokens",{timeout:10_000});
    await expect(context).not.toContainText("14,542");
    await expect(context).toHaveAttribute("title","Context 8,422 input · 14,542 total");
    await page.screenshot({animations:"disabled",path:auditDir+`native-context-meter-last-request-${mode}-1280.png`});
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
