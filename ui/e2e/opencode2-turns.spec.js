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
// message before), a provider retry shows as the turn's retry row and then reads recovered, and a question OpenCode asks is the
// question dialog, whose answer the turn goes on with. The real agent relay runs the real OpenCode 2 session and @opencode/client
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

test("an OpenCode 2 provider retry shows as the turn's retry row, then reads recovered once OpenCode answers",async({page})=>{
  test.setTimeout(90_000);
  let release=()=>{};const back=new Promise(resolve=>{release=resolve});
  const ANSWER="Hello again, the provider answered after one retry.";
  await openCode2App(page,async({sessionID,emit,reply:keep})=>{
    const created=Date.now();
    emit({type:"session.retry.scheduled",created,data:{sessionID,assistantMessageID:"msg_a1",attempt:2,at:created+30_000,error:{type:"provider.rate-limit",message:"429 Too Many Requests"}}});
    await back;keep(ANSWER);reply(emit,sessionID,ANSWER);
  },async()=>{
    await send(page,"Say hello");
    const row=page.locator(".tool-event.kind-retry"),card=page.getByTestId("activity-card").filter({has:row});
    await expect(row).toBeVisible({timeout:20_000});
    await expect(row.locator("summary strong")).toHaveText("Retrying: 429 Too Many Requests. OpenCode retries opencode/big-pickle in 30 s (retry 1).");
    await expect(row.locator("summary em")).toHaveText("retrying");await expect(row).toHaveClass(/status-running/);
    await expect(card.locator(".activity-card-failed")).toHaveCount(0);await expect(page.locator(".tool-event.kind-error")).toHaveCount(0);
    await expect(stopButton(page),"the turn goes on while OpenCode retries").toBeVisible();
    await shots(page,"opencode2-retry-waiting",()=>expect(row).toBeVisible());
    release();
    await expect(page.locator(".assistant-message-text").filter({hasText:ANSWER})).toBeVisible({timeout:20_000});
    await expect(row.locator("summary strong")).toHaveText("Recovered after retrying");await expect(row.locator("summary em")).toHaveText("recovered");
    await expect(row).toHaveClass(/status-done/);await expect(stopButton(page)).toHaveCount(0);
    await row.locator("summary").click();
    await expect(row.locator(".tool-event-body pre")).toHaveText("429 Too Many Requests. OpenCode retries opencode/big-pickle in 30 s (retry 1).");
    await shots(page,"opencode2-retry-recovered",()=>expect(row).toBeVisible());
  });
});

test("an OpenCode 2 question is the question dialog, and the turn goes on with the person's answers",async({page})=>{
  test.setTimeout(120_000);
  const answer=name=>`The ${name} theme uses amber and blue.`;let asked=0;
  await openCode2App(page,async({fake,sessionID,emit,reply:keep})=>{
    const formID=`frm_theme_${++asked}`;
    emit({type:"form.created",data:{form:{id:formID,sessionID,title:"Questions",metadata:{kind:"question"},fields:[
      {key:"colors",type:"multiselect",title:"Colors",description:"Which colors should the theme use?",options:[{value:"amber",label:"Amber",description:"Warm accents"},{value:"blue",label:"Blue",description:"Cool accents"},{value:"green",label:"Green"}]},
      {key:"name",type:"string",title:"Name",description:"What should the theme be called?"},
    ]}}});
    for(let waited=0;!fake.forms.get(formID)?.settled&&waited<1600;waited++)await new Promise(resolve=>setTimeout(resolve,50));
    const name=fake.called(`POST /api/session/ses_main/form/${formID}/reply`)[0]?.body?.answer?.name||"unnamed";
    keep(answer(name));reply(emit,sessionID,answer(name));
  },async({fake})=>{
    const dialog=page.getByRole("dialog",{name:"Agent needs input"});
    // The dialog covers the header, so the mode is switched before each question comes.
    for(const [index,[mode,name]] of [["dark","Sunrise"],["light","Moonlight"]].entries()){
      if(await page.evaluate(()=>document.documentElement.dataset.mode)!==mode)await page.getByTestId("appearance-toggle").click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      await send(page,`Make me a ${mode} theme`);
      await expect(dialog).toBeVisible({timeout:20_000});
      const [colors,field]=[dialog.locator(".question-block").nth(0),dialog.locator(".question-block").nth(1)];
      await expect(colors).toContainText("Which colors should the theme use?");await expect(field).toContainText("What should the theme be called?");
      // The colors take only OpenCode's choices; the name takes the person's own words.
      await expect(colors.getByPlaceholder("Custom answer…")).toHaveCount(0);await expect(field.getByPlaceholder("Custom answer…")).toBeVisible();
      await colors.getByRole("button",{name:/Amber/}).click();await colors.getByRole("button",{name:/Blue/}).click();
      await expect(colors.getByRole("button",{name:/Amber/})).toHaveAttribute("aria-pressed","true");
      await field.getByPlaceholder("Custom answer…").click();await page.keyboard.type(name,{delay:5});
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(dialog).toBeVisible();await page.screenshot({animations:"disabled",path:`${auditDir}opencode2-question-${mode}-${width}x800.png`})}
      await page.setViewportSize({width:1280,height:800});
      await dialog.getByRole("button",{name:"Submit"}).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(()=>fake.called(`POST /api/session/ses_main/form/frm_theme_${index+1}/reply`).map(call=>call.body)).toEqual([{answer:{colors:["amber","blue"],name}}]);
      await expect(page.locator(".assistant-message-text").filter({hasText:answer(name)}),"the turn went on with the answers").toBeVisible({timeout:20_000});
      await expect(stopButton(page)).toHaveCount(0);
    }
    await shots(page,"opencode2-question-answered");
  });
});

// OpenCode 2 sends session.tool.input.started as the model starts a call and session.tool.called once its input is whole and the tool
// runs. The row read running from the first, as a tool that ran, and carried OpenCode's raw tool name ("bash", "read") where OpenCode
// 1.x's rows read "Run command" pending, then running. OpenCode 2.0.24's own read output names the file it read.
test("an OpenCode 2 call whose input still streams reads pending until OpenCode calls it, and its rows are titled as OpenCode 1.x titles them",async({page})=>{
  test.setTimeout(120_000);
  const READ="Read file notes.txt, lines 1-2\n1: alpha line\n2: beta line",ANSWER="The tests pass, and notes.txt has two lines.";
  let call=()=>{},finish=()=>{},folder="";const called=new Promise(resolve=>{call=resolve}),finished=new Promise(resolve=>{finish=resolve});
  await openCode2App(page,async({sessionID,emit,reply:keep})=>{
    const tool=(type,id,data)=>emit({type:`session.tool.${type}`,data:{sessionID,assistantMessageID:"msg_a1",id,...data}});
    tool("input.started","call_bash",{name:"bash"});
    await called;tool("called","call_bash",{input:{command:"npm test"},executed:false});
    await finished;tool("success","call_bash",{content:[{type:"text",text:"12 passing"}],executed:true});
    tool("input.started","call_read",{name:"read"});tool("called","call_read",{input:{filePath:join(folder,"notes.txt")},executed:false});
    tool("success","call_read",{content:[{type:"text",text:READ}],executed:true});
    keep(ANSWER);reply(emit,sessionID,ANSWER);
  },async({root})=>{
    folder=root;
    await send(page,"Run the tests, then read notes.txt");
    const rows=page.locator(".tool-event"),command=rows.first();
    await expect(command,"a call whose input still streams has not started").toHaveClass(/status-pending/,{timeout:20_000});
    await expect(command.locator("summary strong")).toHaveText("Run command");await expect(command.locator("summary em")).toHaveText("pending");
    await shots(page,"opencode2-call-pending",()=>expect(command.locator("summary em")).toHaveText("pending"));
    call();
    await expect(command,"OpenCode called it: it runs").toHaveClass(/status-running/);
    await expect(command.locator("summary strong")).toHaveText("Run command");await expect(command.locator("summary em")).toHaveText("running");
    await command.locator("summary").click();
    await expect(command.locator(".tool-event-body pre").first(),"the row opens to the command it runs").toHaveText("npm test");
    finish();
    await expect(page.locator(".assistant-message-text").filter({hasText:ANSWER})).toBeVisible({timeout:20_000});
    await expect(stopButton(page)).toHaveCount(0);
    await expect(rows.locator("summary strong"),"named as OpenCode 1.x names them").toHaveText(["Run command","Read notes.txt"]);
    await expect(rows.locator("summary em")).toHaveText(["done","done"]);
    await rows.nth(1).locator("summary").press("Enter");
    await expect(rows.nth(1).locator(".tool-event-body pre")).toHaveJSProperty("textContent",READ);
    await shots(page,"opencode2-call-titles",()=>expect(rows.nth(1).locator(".tool-event-body pre")).toBeVisible());
    // The thread opened again after a reload names them the same.
    await page.reload();await page.getByRole("button",{name:/Theme check/}).click();
    await expect(rows.locator("summary strong")).toHaveText(["Run command","Read notes.txt"],{timeout:20_000});
    await expect(rows.locator("summary em")).toHaveText(["done","done"]);
  });
});
