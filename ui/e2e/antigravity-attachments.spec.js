import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,readFile,rm,truncate,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename,join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { select } from "../../tests/fixtures/scripted-acp.mjs";
import { keepThreadMeta } from "./test-home.js";

// What an Antigravity chat sends of the files a person attaches, as Antigravity 1.2.1 advertises itself (images, audio and embedded
// context) and as T3 sends them (buildAntigravityPrompt, 532023a24): an mp3 goes as audio after the line that names it, a PNG as an
// image and a GIF by its saved path; a message whose image does not fit in the 50 MiB Antigravity takes in one message ends saying
// which image and what to do. The real relay and Antigravity session run the scripted ACP agent (tests/fixtures/scripted-acp-agent.mjs)
// as Antigravity, and its log shows what it was sent. A chat whose Antigravity stops as it starts (the stand-in for Antigravity's own
// server, tests/fixtures/antigravity-acp-agent.mjs) says so in plain words, never pointing to the sign-in link it hides.
const auditDir=fileURLToPath(new URL("../../visual-audit/antigravity-attachments/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const AGENT=fileURLToPath(new URL("../../tests/fixtures/scripted-acp-agent.mjs",import.meta.url));
const AGY_AGENT=fileURLToPath(new URL("../../tests/fixtures/antigravity-acp-agent.mjs",import.meta.url));
const MODEL="gemini-3.8-flash-high",MiB=1024*1024;
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
const PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==","base64");
const MEMO=Buffer.from("ID3 a short spoken memo");
// Antigravity 1.2.1's initialize as it answered in an isolated home (no sign-in), and a session that answers each prompt with a reply.
const scenario=replies=>({
  initialize:{protocolVersion:1,agentInfo:{name:"antigravity-acp",title:"Google Antigravity",version:"1.2.1"},agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},resume:{}},promptCapabilities:{image:true,audio:true,embeddedContext:true}}},
  sessionNew:{sessionId:"agy-session",models:{currentModelId:MODEL,availableModels:[{modelId:MODEL,name:"Gemini 3.8 Flash (High)"}]},configOptions:[select("mode","mode","default",["default","auto_edit"]),select("model","model",MODEL,[[MODEL,"Gemini 3.8 Flash (High)"]])]},
  prompts:replies.map(text=>({steps:[{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text}}}]})),
});

// The app on the real agent relay with an Antigravity profile behind it, opened on its thread "Recording check". With exit, the chat
// runs the stand-in for Antigravity's own server, which exits as that scenario says (exitWith changes it for the next start); the
// chat's launch takes no Google key of the test's environment, only the Gemini API key saved for it (saveKey), as Trebell's does.
async function antigravityApp(page,replies,run,{exit=null}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-antigravity-app-")),scenarioPath=join(root,"scenario.json"),logPath=join(root,"agent-log.jsonl"),exitPath=join(root,"exit-scenario.json");
  await writeFile(scenarioPath,JSON.stringify(scenario(replies)),"utf8");
  const exitWith=value=>writeFile(exitPath,JSON.stringify(value),"utf8");if(exit)await exitWith(exit);
  const instance={id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true};
  const childEnv={...process.env,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TREBELL_ACP_SCENARIO:scenarioPath,TREBELL_ACP_LOG:logPath,TREBELL_AGY_SCENARIO:exitPath},saved={key:null};
  delete childEnv.GEMINI_API_KEY;delete childEnv.GOOGLE_API_KEY;
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"home")});
  const seed=threadStore.create({runtime:"antigravity",cwd:root,providerSessionId:"",model:MODEL,name:"Recording check"});
  const runtimeManager={
    activeRuntime:()=>"antigravity",activeInstance:()=>instance,instances:()=>[instance],compatibleInstanceIds:()=>[instance.id],
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...childEnv,...(saved.key?{GEMINI_API_KEY:saved.key}:{})}),executable:()=>process.execPath,acpArgs:()=>[exit?AGY_AGENT:AGENT],
    probe:async()=>({id:instance.id,name:"Antigravity",available:true,authenticated:true,version:"1.2.1"}),env:{...process.env,TREBELL_HOME:join(root,"home")},
  };
  const meta=new Map([[seed.id,{projectless:true,environmentId:null}]]);
  const state={settings:()=>({activeEnvironmentId:null,continueThreadsAfterRestart:false}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},recordUsage:()=>{}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:null,state,version:"fixture"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;
  // What the agent was sent, in the order it came.
  const log=async()=>{try{return (await readFile(logPath,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))}catch{return []}};
  try{
    await keepThreadMeta(page);
    const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"antigravity",agentRuntimeInstanceId:instance.id,modelProvider:"openai",defaultPermissionMode:"auto",defaultWorkspaceMode:"current"};
    // The page's settings stay in the page: a change (the appearance toggle) is kept here, not on the shared mock server.
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"antigravity",agentRuntimeInstanceId:instance.id,agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",cwd:root,platform:process.platform,version:"fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{[seed.id]:{projectless:true,environmentId:null}}}));
    await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{agentRuntime:"antigravity",ready:true,models:[MODEL],defaultModel:MODEL,metadata:{models:[{id:MODEL,name:"Gemini 3.8 Flash (High)",agent:"antigravity"}]},error:null}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await page.getByRole("button",{name:/Recording check/}).click();
    await expect(page.getByTestId("composer")).toBeEnabled();
    await run({root,log,threadStore,threadId:seed.id,exitWith,saveKey:key=>{saved.key=key}});
  }finally{
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));threadStore.close();
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
}
// The files picked through Attach files, uploaded and taken in as the composer does it, each on the shelf once it is in.
async function attach(page,files){
  const [chooser]=await Promise.all([page.waitForEvent("filechooser"),page.getByRole("button",{name:"Attach files"}).click()]);
  await chooser.setFiles(files);
  for(const file of files)await expect(page.getByRole("button",{name:"Remove "+file.name})).toBeVisible({timeout:20_000});
}
async function send(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:5});await page.getByTestId("send").click()}
// Dark and light at 1280x800 and 900x800, switched with the header's toggle as a person switches them.
async function shots(page,name,check=async()=>{}){
  for(const mode of ["dark","light"]){
    if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").first().click();
    await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await check();await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${width}x800.png`})}
  }
  await page.setViewportSize({width:1280,height:800});
  if(await page.locator("html").getAttribute("data-mode")!=="dark")await page.getByTestId("appearance-toggle").first().click();
}
const prompts=entries=>entries.filter(entry=>entry.method==="session/prompt").map(entry=>entry.params.prompt);
// The line that names a saved upload (<time>-<id>-<name>, as the GUI server saves it) by its path.
const namedLine=(kind,name)=>new RegExp(`^\\[Attached ${kind} "\\d{10,}-[0-9a-f]{8}-${name.replace(".","\\.")}" is saved at: .+${name.replace(".","\\.")}\\]$`);

test("an mp3 attached to an Antigravity chat reaches it as audio after the line that names it, a PNG as an image and a GIF by its saved path",async({page})=>{
  test.setTimeout(120_000);
  await antigravityApp(page,["The memo says the build is green, and the picture is a single red dot."],async({log})=>{
    await attach(page,[{name:"memo.mp3",mimeType:"audio/mpeg",buffer:MEMO},{name:"loop.gif",mimeType:"image/gif",buffer:Buffer.from("GIF89a")},{name:"dot.png",mimeType:"image/png",buffer:PNG}]);
    await send(page,"What is said, and what is in the pictures?");
    const reply=page.locator(".assistant-message-text").filter({hasText:"The memo says the build is green"});
    await expect(reply).toBeVisible({timeout:20_000});
    const [prompt]=prompts(await log());
    expect(prompt?.[0]?.text,"the person's words come first").toContain("What is said, and what is in the pictures?");
    const audioLine=prompt.findIndex(part=>part.type==="text"&&namedLine("audio","memo.mp3").test(part.text));
    expect(audioLine,"the mp3 is named by its saved path").toBeGreaterThan(0);
    expect(prompt[audioLine+1],"and its audio follows the line").toEqual({type:"audio",mimeType:"audio/mpeg",data:MEMO.toString("base64")});
    expect(prompt.filter(part=>part.type==="text"&&namedLine("image","loop.gif").test(part.text)),"the GIF is named by its saved path").toHaveLength(1);
    expect(prompt.filter(part=>part.type==="image"),"only the PNG goes as an image").toEqual([{type:"image",mimeType:"image/png",data:PNG.toString("base64")}]);
    await shots(page,"audio-image-and-gif",()=>expect(reply).toBeVisible());
  });
});

test("a message whose image does not fit in what Antigravity takes in one message ends saying which image and what to do, and the chat goes on",async({page})=>{
  test.setTimeout(120_000);
  await antigravityApp(page,["The report has three sections."],async({root,log})=>{
    // A 50 MiB PDF (a file of zeros, written without holding it in memory) stands for the upload of report.pdf, which the GUI server
    // would have saved under its own name; the screenshot is uploaded as a person uploads it.
    const report=join(root,"attachments","1761500000000-ab12cd34-report.pdf");mkdirSync(join(root,"attachments"),{recursive:true});
    await writeFile(report,"");await truncate(report,50*MiB);
    await page.route(/\/api\/attachments\/blob$/,route=>route.request().postDataJSON()?.name==="report.pdf"?json(route,{path:report,name:basename(report),size:50*MiB,mime:"application/pdf"}):route.fallback());
    await attach(page,[{name:"report.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-1.7")},{name:"dot.png",mimeType:"image/png",buffer:PNG}]);
    await send(page,"Does the screenshot match the report?");
    const said=page.getByText('The attached image "dot.png" is too large for one Antigravity message, which takes images up to 10 MiB and 50 MiB of attachments in all. Send it in a message of its own.').first();
    await expect(said).toBeVisible({timeout:20_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0);
    expect(prompts(await log()),"Antigravity was sent nothing").toEqual([]);
    await shots(page,"image-past-the-message-limit",()=>expect(said).toBeVisible());
    // The person sends the report on its own, and the chat takes it.
    await attach(page,[{name:"report.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-1.7")}]);
    await send(page,"Then just the report: what is in it?");
    await expect(page.locator(".assistant-message-text").filter({hasText:"The report has three sections."})).toBeVisible({timeout:20_000});
    const [prompt]=prompts(await log());
    expect(prompt.filter(part=>part.type==="resource_link").map(part=>[part.name,part.mimeType]),"the report goes as a document link").toEqual([[basename(report),"application/pdf"]]);
  });
});

test("an Antigravity that stops as it starts is named with its exit code, and one that asked for a Google sign-in is pointed to its key, not to the link it hides",async({page})=>{
  test.setTimeout(120_000);
  const SIGN_IN="https://accounts.google.com/o/oauth2/v2/auth?state=x&redirect_uri=http://127.0.0.1:4567/",KEY="AIzaSyE2eFixtureKeyForTrebell0123456789";
  await antigravityApp(page,[],async({exitWith,saveKey})=>{
    const composer=page.getByTestId("composer"),alert=page.getByTestId("composer-alert");
    // No key saved, sent with Enter: what Antigravity asked for, and where it signs in instead.
    await composer.click();await page.keyboard.type("Summarize the repository",{delay:5});await page.keyboard.press("Enter");
    await expect(alert).toHaveText("Not sent: Antigravity stopped as it started, with exit code 3, asking for a Google sign-in. Sign in to Antigravity in Settings, then try again. Your draft is kept.",{timeout:20_000});
    await expect(composer).toHaveValue("Summarize the repository");
    expect(await page.locator("body").innerText(),"no runtime words, link or address on the page").not.toMatch(/ACP runtime|code=|signal=|sign-in-url|following link|accounts\.google\.com|127\.0\.0\.1:4567/);
    await shots(page,"start-exit-sign-in",()=>expect(alert).toBeVisible());
    // With a key saved, sent with the Send button: the key to check.
    saveKey(KEY);
    await page.getByTestId("send").click();
    await expect(alert).toHaveText("Not sent: Antigravity stopped as it started, with exit code 3, asking for a Google sign-in, though it runs on the Google Gemini API key saved in Settings. Check that key there, then try again. Your draft is kept.",{timeout:20_000});
    // One that fails as it starts: what it printed, after how it ended.
    await exitWith({exitAt:"start",exitCode:1,stderr:"ValueError: Unexpected git description\n"});
    await page.getByTestId("send").click();
    await expect(alert).toHaveText("Not sent: Antigravity stopped as it started, with exit code 1: ValueError: Unexpected git description. Your draft is kept.",{timeout:20_000});
    await expect(composer).toHaveValue("Summarize the repository");
    await shots(page,"start-exit-printed",()=>expect(alert).toBeVisible());
  },{exit:{exitAt:"initialize",exitCode:3,stderr:"Open the following link to authenticate the ACP server: "+SIGN_IN+"\n"}});
});
