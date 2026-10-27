import { expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { startFakeOpenCode1 } from "../../tests/fixtures/fake-opencode1-server.mjs";
import { startFakeOpenCode2,writeFakeOpenCode2Serve } from "../../tests/fixtures/fake-opencode2-server.mjs";
import { keepThreadMeta } from "./test-home.js";

// The app on the real agent relay with an OpenCode profile behind it, opened on its thread "Theme check": the relay drives the real
// OpenCode session against a stand-in server. OpenCode 1.x (openCode1App) is the profile's own server (serverUrl), a fake
// OpenCode 1.x server (tests/fixtures/fake-opencode1-server.mjs) whose onPrompt plays each turn. OpenCode 2 (openCode2App) is the
// thread folder's `serve` stand-in for the fake OpenCode 2 server (tests/fixtures/fake-opencode2-server.mjs), as opencode2-turns does.
export const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
export const MODEL="opencode/big-pickle";
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

// Dark and light screenshots at 1280x800 and 900x800, switched with the header's toggle as a person switches them.
export async function shots(page,name,check=async()=>{}){
  for(const width of [1280,900]){
    await page.setViewportSize({width,height:800});
    for(const mode of ["dark","light"]){
      if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);await check();
      await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${width}x800.png`});
    }
  }
  await page.setViewportSize({width:1280,height:800});
  if(await page.evaluate(()=>document.documentElement.dataset.mode)!=="dark")await page.getByTestId("appearance-toggle").click();
}
export async function send(page,text){
  const composer=page.getByTestId("composer");await composer.click();await page.keyboard.type(text,{delay:5});await page.getByTestId("send").click();
}
export const stopButton=page=>page.getByRole("button",{name:"Stop",exact:true});

async function relayApp(page,{root,version,instance,childEnv},run,context){
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"home")});
  const seed=threadStore.create({runtime:"opencode",cwd:root,providerSessionId:"",model:MODEL,name:"Theme check"});
  const runtimeManager={
    activeRuntime:()=>"opencode",activeInstance:()=>instance,instances:()=>[instance],compatibleInstanceIds:()=>[instance.id],
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>childEnv,executable:()=>process.execPath,
    probe:async()=>({id:instance.id,name:"OpenCode",available:true,authenticated:true,version}),
  };
  const meta=new Map([[seed.id,{projectless:true,environmentId:null}]]);
  const state={settings:()=>({activeEnvironmentId:null,continueThreadsAfterRestart:false}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},recordUsage:()=>{}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:null,state,version:"fixture"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;
  try{
    await keepThreadMeta(page);
    const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"opencode",agentRuntimeInstanceId:instance.id,modelProvider:"openai",defaultPermissionMode:"auto",defaultWorkspaceMode:"current"};
    // The page's settings stay in the page: a change (the appearance toggle) is kept here, not on the shared mock server.
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"opencode",agentRuntimeInstanceId:instance.id,agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",cwd:root,platform:process.platform,version:"fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{[seed.id]:{projectless:true,environmentId:null}}}));
    await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:[MODEL],metadata:{provider:"opencode",models:[{id:MODEL,name:"Big Pickle",provider:"opencode",agent:"OpenCode"}]}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await page.getByRole("button",{name:/Theme check/}).click();
    await expect(page.getByTestId("composer")).toBeEnabled();
    await run({...context,root,threadStore,threadId:seed.id});
  }finally{
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));threadStore.close();
  }
}

export async function openCode1App(page,onPrompt,run){
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode1-app-"));
  const fake=await startFakeOpenCode1({onPrompt:turn=>onPrompt({...turn,fake})});
  try{await relayApp(page,{root,version:"1.18.32",instance:{id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,serverUrl:fake.url},childEnv:{...process.env}},run,{fake})}
  finally{await fake.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
}

// fakeOptions go to the fake OpenCode 2 server (heartbeatMs, say).
export async function openCode2App(page,onPrompt,run,fakeOptions={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode2-app-"));await writeFakeOpenCode2Serve(root);
  const fake=await startFakeOpenCode2({...fakeOptions,onPrompt:turn=>onPrompt({...turn,fake})});
  try{await relayApp(page,{root,version:"2.0.24",instance:{id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true},childEnv:{...process.env,FAKE_OPENCODE2_URL:fake.url}},run,{fake})}
  finally{await fake.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
}
