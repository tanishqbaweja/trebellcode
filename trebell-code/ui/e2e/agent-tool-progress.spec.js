import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}

test("non-Codex ACP command progress streams visibly and terminal tool calls settle",async({page})=>{
  test.setTimeout(40_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-progress-"));
  const fixture=join(root,"fake-acp-progress.mjs");
  await writeFile(fixture,String.raw`
import readline from "node:readline";
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));let sessionId="fixture-session";
function send(value){process.stdout.write(JSON.stringify(value)+"\n")}
async function handle(message){
  if(!message.method||message.id==null)return;
  if(message.method==="initialize")return send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}}}}});
  if(message.method==="session/new"||message.method==="session/resume"||message.method==="session/load")return send({jsonrpc:"2.0",id:message.id,result:{sessionId,models:{currentModelId:"fixture-model",availableModels:[{modelId:"fixture-model",name:"Fixture Model"}]},configOptions:[],modes:{currentModeId:"build",availableModes:[]}}});
  if(message.method==="session/set_model"||message.method==="session/close")return send({jsonrpc:"2.0",id:message.id,result:{}});
  if(message.method==="session/prompt"){
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"tool_call",toolCallId:"cmd-stream",title:"Fixture build",kind:"execute",status:"in_progress",rawOutput:"phase one\n"}}});
    await delay(700);
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:"cmd-stream",title:"Fixture build",kind:"execute",status:"in_progress",rawOutput:"phase one\nphase two\n"}}});
    await delay(700);
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"tool_call_update",toolCallId:"cmd-stream",title:"Fixture build",kind:"execute",status:"completed",rawOutput:"phase one\nphase two\ndone\n"}}});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"tool_call",toolCallId:"cmd-fast",title:"Quick check",kind:"execute",status:"completed",rawOutput:"quick complete\n"}}});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Fixture finished."}}}});
    return send({jsonrpc:"2.0",id:message.id,result:{stopReason:"end_turn"}});
  }
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line)).catch(error=>send({jsonrpc:"2.0",id:null,error:{code:-32603,message:error.message}}))}catch{}});
`,"utf8");
  const env={...process.env,TREBELL_HOME:join(root,"home")};const threadStore=new AgentThreadStore(env);
  const seed=threadStore.create({runtime:"gemini",cwd:root,providerSessionId:"",model:"fixture-model",name:"ACP progress fixture"});
  const instance={id:"gemini-default",kind:"gemini",displayName:"Fixture ACP",enabled:true};
  const runtimeManager={
    activeRuntime:()=>"gemini",activeInstance:()=>instance,instances:()=>[instance],
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>process.env,
    executable:()=>process.execPath,acpArgs:()=>[fixture],compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:instance.displayName,available:true,authenticated:true,version:"fixture"}),
  };
  const meta=new Map([[seed.id,{projectless:true,environmentId:null}]]);
  const state={
    settings:()=>({activeEnvironmentId:null,continueThreadsAfterRestart:false}),
    threadMeta:id=>meta.get(id)||{},
    updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},
    recordUsage:()=>{},
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:null,state,version:"fixture"});
  const port=await listen(server);
  try{
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,loggedIn:true,provider:"freebuff",providerReady:true,agentRuntime:"gemini",agentRuntimeInstanceId:"gemini-default",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",cwd:root,platform:"win32",version:"fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"gemini",agentRuntimeInstanceId:"gemini-default",modelProvider:"freebuff",defaultPermissionMode:"full",defaultWorkspaceMode:"current"},projects:[],threadMeta:{[seed.id]:{projectless:true,environmentId:null}}})}));
    await page.route(/\/api\/models(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["fixture-model"],metadata:{provider:"gemini",models:[{id:"fixture-model",name:"Fixture Model",provider:"gemini",agent:"Gemini"}]}})}));
    await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
    await page.goto("/");
    await page.getByRole("button",{name:/ACP progress fixture/}).click();
    const composer=page.getByTestId("composer");await expect(composer).toBeEnabled();await composer.fill("Run the fixture command");await page.getByTestId("send").click();
    const streamed=page.locator(".tool-event").filter({hasText:"Fixture build"});await expect(streamed).toBeVisible();await streamed.locator("summary").click();
    await expect(streamed).toContainText("phase one");await page.setViewportSize({width:1280,height:800});await page.screenshot({path:auditDir+"agent-tool-progress-running-1280x800.png",fullPage:true});
    await expect(streamed).toContainText("phase two");
    await expect(streamed.locator("summary")).toContainText("done");
    const quick=page.locator(".tool-event").filter({hasText:"Quick check"});await expect(quick.locator("summary")).toContainText("done");
    await expect(page.locator(".assistant-message-text")).toContainText("Fixture finished.");
    await expect(page.locator(".tool-event")).toHaveCount(2);
    await expect(page.locator(".tool-event").filter({hasText:"Agent activity"})).toHaveCount(0);
    await page.screenshot({path:auditDir+"agent-tool-progress-complete-1280x800.png",fullPage:true});
  }finally{
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});
  }
});
