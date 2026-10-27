import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { startFakeOpenCode2,writeFakeOpenCode2Serve } from "../../tests/fixtures/fake-opencode2-server.mjs";
import { keepThreadMeta } from "./test-home.js";

// OpenCode 2 turns as a person sees them: a screenshot pasted into the chat reaches OpenCode as a file it reads (it refused the whole
// message before). The real agent relay runs the real OpenCode 2 session and @opencode/client
// against a stand-in for `opencode serve` (tests/fixtures/fake-opencode2-server.mjs), which answers as OpenCode 2.0.24 does.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
const MODEL="opencode/big-pickle";
const RED_SQUARE=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABcklEQVR4nO3RUW1DAQwEwYB4/JGFS8ogf6d121kZgHXz+ijtVT/w3wMQByAOQByAOABxAOIAxAGIAxAHIA5AHIA4AHEA4gDEAYgDEAcgDkAcgDgAcQDiAMQBiAMQByAOQByAOABxAOLmAO/n+dW33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gcAgNu33gfAXwfQ9wDEAYgDEAcgDkAcgDgAcQDiAMQBiAMQByAOQByAOABxAOIAxAGIAxAHIA5AHIA4AHEA4gDEAYgDEAcgDkAcgDgAcT8K4rlSmTUupQAAAABJRU5ErkJggg==","base64");

// Dark and light screenshots at 1280x800 and 900x800, switched with the header's toggle as a person switches them.
async function shots(page,name,check=async()=>{}){
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

// The app on a relay with an OpenCode 2 profile behind it, opened on its thread "Theme check". The thread's folder holds the `serve`
// stand-in, so the session runs OpenCode as its own server (whose files it is sent). onPrompt plays each turn on the fake server.
async function openCode2App(page,onPrompt,run){
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode2-turns-"));await writeFakeOpenCode2Serve(root);
  const fake=await startFakeOpenCode2({onPrompt:turn=>onPrompt({...turn,fake})});
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"home")});
  const seed=threadStore.create({runtime:"opencode",cwd:root,providerSessionId:"",model:MODEL,name:"Theme check"});
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true};
  const runtimeManager={
    activeRuntime:()=>"opencode",activeInstance:()=>instance,instances:()=>[instance],compatibleInstanceIds:()=>[instance.id],
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env,FAKE_OPENCODE2_URL:fake.url}),executable:()=>process.execPath,
    probe:async()=>({id:instance.id,name:"OpenCode",available:true,authenticated:true,version:"2.0.24"}),
  };
  const meta=new Map([[seed.id,{projectless:true,environmentId:null}]]);
  const state={settings:()=>({activeEnvironmentId:null,continueThreadsAfterRestart:false}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},recordUsage:()=>{}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:null,state,version:"fixture"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;
  try{
    await keepThreadMeta(page);
    const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",modelProvider:"openai",defaultPermissionMode:"auto",defaultWorkspaceMode:"current"};
    // The page's settings stay in the page: a change (the appearance toggle) is kept here, not on the shared mock server.
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",cwd:root,platform:process.platform,version:"fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{[seed.id]:{projectless:true,environmentId:null}}}));
    await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:[MODEL],metadata:{provider:"opencode",models:[{id:MODEL,name:"Big Pickle",provider:"opencode",agent:"OpenCode"}]}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await page.getByRole("button",{name:/Theme check/}).click();
    await expect(page.getByTestId("composer")).toBeEnabled();
    await run({fake,root,threadStore,threadId:seed.id});
  }finally{
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await fake.close();threadStore.close();
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
}
async function send(page,text){
  const composer=page.getByTestId("composer");await composer.click();await page.keyboard.type(text,{delay:5});await page.getByTestId("send").click();
}
const stopButton=page=>page.getByRole("button",{name:"Stop",exact:true});
const reply=(emit,sessionID,words)=>{
  emit({type:"session.text.started",data:{sessionID,assistantMessageID:"msg_a1",ordinal:0}});
  emit({type:"session.text.delta",data:{sessionID,assistantMessageID:"msg_a1",delta:words}});
  emit({type:"session.execution.succeeded",data:{sessionID}});
};

test("a screenshot sent to an OpenCode 2 thread reaches OpenCode as a file it reads, and OpenCode answers about it",async({page},testInfo)=>{
  test.setTimeout(90_000);
  const ANSWER="It shows a red square centered on a white background.";
  await openCode2App(page,({body,sessionID,emit,reply:keep})=>{if(body?.files?.length){keep(ANSWER);reply(emit,sessionID,ANSWER)}},async({fake})=>{
    const shot=testInfo.outputPath("red-square.png");await writeFile(shot,RED_SQUARE);
    // The person picks the screenshot with Attach files, as they would, then asks about it.
    const [chooser]=await Promise.all([page.waitForEvent("filechooser"),page.getByRole("button",{name:"Attach files"}).click()]);
    await chooser.setFiles(shot);
    await expect(page.locator(".attachment-shelf > span").filter({hasText:"red-square"})).toBeVisible();
    await send(page,"What does this screenshot show?");
    const answer=page.locator(".assistant-message-text").filter({hasText:ANSWER});
    await expect(answer,"OpenCode took the message with its screenshot and answered").toBeVisible({timeout:30_000});
    await expect(stopButton(page)).toHaveCount(0);
    await expect(page.locator(".tool-event.kind-error")).toHaveCount(0);
    const [prompted]=fake.prompts();
    expect(prompted.files).toHaveLength(1);
    expect(prompted.files[0].uri).toMatch(/^file:\/\/\/.*red-square\.png$/);expect(prompted.files[0].name).toMatch(/red-square\.png$/);
    expect(prompted.text).toMatch(/What does this screenshot show\?\n\[Attached image ".*red-square\.png" is saved at: .*red-square\.png\]$/);
    await shots(page,"opencode2-image-answered",()=>expect(answer).toBeVisible());
  });
});
