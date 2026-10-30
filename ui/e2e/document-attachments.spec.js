import { test,expect } from "@playwright/test";
import { mkdirSync,readFileSync } from "node:fs";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { select } from "../../tests/fixtures/scripted-acp.mjs";
import { routeCodexApp,startCodexHarness } from "./codex-history-harness.js";
import { e2eHome,keepThreadMeta } from "./test-home.js";

// A Word document a person attaches reaches the agent as text it can read:
// the GUI server extracts its text as it is uploaded, Codex's message names the file the text went to after the document's path, a
// question's answer does too, and Antigravity, which cannot open Trebell's attachments folder, gets the text itself. The message's bubble
// still shows the document by its name. The mock GUI server uploads and extracts for real; Codex and Antigravity are stand-ins.
const auditDir=fileURLToPath(new URL("../../visual-audit/document-attachments/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const REPORT=readFileSync(fileURLToPath(new URL("../../tests/fixtures/documents/report.docx",import.meta.url)));
const DOCX="application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const REPORT_TEXT="# Quarterly Harbor Report\nCargo volume rose 12 percent & the new crane is running.\nPort\tTons\nJuniper\t4200\nNext review: March.";
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
// The line Codex's message names an attached document by, with the saved path and the file its text was extracted to.
const DOCUMENT_LINE=/\[Attached file "report\.docx" is saved at: ([^\n]+?report\.docx) \(text extracted to: ([^\n]+?report\.docx\.txt)\)\]/;

// The files picked through Attach files (the composer's, or a question's), uploaded and taken in as a person attaches them.
async function attach(page,button,files){
  const [chooser]=await Promise.all([page.waitForEvent("filechooser"),button.click()]);
  await chooser.setFiles(files);
}
async function send(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:5});await page.keyboard.press("Enter")}
// Dark and light at 1280x800 and 900x800, switched with the header's toggle as a person switches them, back in dark after.
async function shots(page,name,check=async()=>{}){
  for(const mode of ["dark","light"]){
    await page.setViewportSize({width:1280,height:800});
    if(await page.locator("html").getAttribute("data-mode")!==mode)await page.locator("[data-testid=appearance-toggle]:visible").first().click();
    await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
    for(const width of [1280,900]){
      await page.setViewportSize({width,height:800});await check();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${width}x800.png`});
    }
  }
  await page.setViewportSize({width:1280,height:800});
  if(await page.locator("html").getAttribute("data-mode")!=="dark")await page.locator("[data-testid=appearance-toggle]:visible").first().click();
}
// Waits for the file a document's text was extracted to, and gives its text.
async function extractedText(path){await expect.poll(()=>readFile(path,"utf8").catch(()=>null),{message:path}).not.toBeNull();return readFile(path,"utf8")}

test("on Codex, an attached Word document's message names the file its text was extracted to, and the message shows the document by its name",async({page})=>{
  test.setTimeout(90_000);
  const thread={id:"codex-document",name:"Harbor report",preview:"Harbor report",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const harness=await startCodexHarness(thread,[(turn,{emit,threadId,finish})=>{
    emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});
    const answer={id:"agent-"+turn.id,type:"agentMessage",text:"The first heading is Quarterly Harbor Report."};turn.items.push(answer);emit({method:"item/completed",params:{threadId,turnId:turn.id,item:answer}});finish("completed");
  }]);
  try{
    await routeCodexApp(page,harness,thread);
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Harbor report"]')}),composer=page.getByTestId("composer");
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);await expect(composer).not.toHaveAttribute("placeholder","Opening thread…");
    await attach(page,page.getByRole("button",{name:"Attach files",exact:true}),[{name:"report.docx",mimeType:DOCX,buffer:REPORT}]);
    await expect(page.getByRole("button",{name:"Remove report.docx"})).toBeVisible({timeout:20_000});
    await send(page,"What is the report's first heading?");
    await expect(page.getByText("The first heading is Quarterly Harbor Report.",{exact:true})).toBeVisible({timeout:20_000});
    const sent=harness.turns.at(-1).items[0].content[0].text,[,saved,textPath]=DOCUMENT_LINE.exec(sent)||[];
    expect(sent,"Codex is told where the document's text is").toMatch(DOCUMENT_LINE);
    expect(textPath).toBe(saved+".txt");
    expect(await extractedText(textPath),"the text Codex reads is the document's").toBe(REPORT_TEXT);
    const bubble=page.locator(".user-bubble").filter({hasText:"What is the report's first heading?"}),files=bubble.locator(".user-attachments > span");
    await expect(files).toHaveText(["report.docx"]);
    await expect(page.getByText(/\(text extracted to: /)).toHaveCount(0);
    await shots(page,"codex-message-with-document",()=>expect(files.first()).toBeInViewport());
    // Another view, then the thread again: the message from Codex's history shows the document by its name, not the line.
    await page.getByRole("button",{name:"New task",exact:true}).click();await expect(bubble).toHaveCount(0);
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    await expect(bubble.locator("p")).toHaveText("What is the report's first heading?",{timeout:15_000});
    await expect(files).toHaveText(["report.docx"]);
    await expect(page.getByText(/\[Attached file |\(text extracted to: /)).toHaveCount(0);
    await shots(page,"codex-message-with-document-reopened",()=>expect(files.first()).toBeInViewport());
  }finally{await harness.close()}
});

// A Codex app-server behind the real Codex relay that lists one thread and asks the window questions as Codex does; asked(method,
// params) sends one, and its answered resolves with the window's answer.
async function startQuestionHarness(thread){
  let socket=null,nextId=7000;const waiting=new Map(),sockets=new Set();
  const upstreamHttp=createServer(),wss=new WebSocketServer({noServer:true});
  upstreamHttp.on("upgrade",(req,raw,head)=>wss.handleUpgrade(req,raw,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);socket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));
      if(message.id!=null&&!message.method){waiting.get(String(message.id))?.(message.result);waiting.delete(String(message.id));return}
      if(message.id==null||!message.method)return;
      const params=message.params||{};let result={};
      if(message.method==="initialize")result={userAgent:"document-question-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume")result={thread:{...thread,id:params.threadId||thread.id},itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(["thread/attachment/list","thread/queue/list","threadSection/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const port=async server=>{await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port};
  const upstreamPort=await port(upstreamHttp),relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await port(relayHttp);
  return {
    wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",turns:[],others:[],
    ask(method,params){const id=nextId++;const answered=new Promise(resolve=>waiting.set(String(id),resolve));socket.send(JSON.stringify({id,method,params}));return {answered}},
    async close(){relay.close();for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])},
  };
}

test("a Word document attached to a question's answer is named with the file its text was extracted to",async({page})=>{
  test.setTimeout(90_000);
  const thread={id:"codex-document-question",name:"Release evidence",preview:"Release evidence",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()/1000-30,updatedAt:Date.now()/1000,turns:[]};
  const harness=await startQuestionHarness(thread);
  try{
    await routeCodexApp(page,harness,thread);
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Release evidence"]')});
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    const modal=page.locator(".question-modal");
    // The question in dark, then again in light: the question's dialog covers the header's light and dark toggle while it is open.
    for(const mode of ["dark","light"]){
      if(await page.locator("html").getAttribute("data-mode")!==mode)await page.locator("[data-testid=appearance-toggle]:visible").first().click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      const asked=harness.ask("item/tool/requestUserInput",{threadId:thread.id,turnId:"turn-evidence",itemId:"q-report-"+mode,questions:[{id:"evidence",header:"Evidence",question:"Attach the release report?",options:[],allowMultiple:false}]});
      await expect(modal).toContainText("Attach the release report?");
      await attach(page,modal.getByRole("button",{name:"Attach files"}),[{name:"report.docx",mimeType:DOCX,buffer:REPORT}]);
      await expect(modal.locator(".question-files span")).toHaveCount(1,{timeout:20_000});
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});await expect(modal.locator(".question-files")).toContainText("report");
        await page.screenshot({animations:"disabled",path:`${auditDir}question-with-document-${mode}-${width}x800.png`});
      }
      await page.setViewportSize({width:1280,height:800});
      await modal.getByRole("button",{name:"Submit",exact:true}).click();
      const [answer]=(await asked.answered).answers.evidence.answers;
      const [,saved,textPath]=/^Attached files:\n- (.+report\.docx) \(text extracted to: (.+report\.docx\.txt)\)$/.exec(answer)||[];
      expect(answer,"the answer names where the document's text is").toMatch(/^Attached files:\n- .+report\.docx \(text extracted to: .+report\.docx\.txt\)$/);
      expect(textPath).toBe(saved+".txt");
      expect(await extractedText(textPath)).toBe(REPORT_TEXT);
      await expect(modal).toHaveCount(0);
    }
  }finally{await harness.close()}
});

// Antigravity 1.2.1's initialize as it answered in an isolated home (no sign-in), and a session that answers each prompt with a reply.
const MODEL="gemini-3.8-flash-high";
const antigravityScenario=replies=>({
  initialize:{protocolVersion:1,agentInfo:{name:"antigravity-acp",title:"Google Antigravity",version:"1.2.1"},agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},resume:{}},promptCapabilities:{image:true,audio:true,embeddedContext:true}}},
  sessionNew:{sessionId:"agy-session",models:{currentModelId:MODEL,availableModels:[{modelId:MODEL,name:"Gemini 3.8 Flash (High)"}]},configOptions:[select("mode","mode","default",["default","auto_edit"]),select("model","model",MODEL,[[MODEL,"Gemini 3.8 Flash (High)"]])]},
  prompts:replies.map(text=>({steps:[{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text}}}]})),
});

test("on Antigravity, an attached Word document's extracted text goes with its message after the line that names it, and a corrupt one goes as its link alone",async({page})=>{
  test.setTimeout(120_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-document-antigravity-")),scenarioPath=join(root,"scenario.json"),logPath=join(root,"agent-log.jsonl");
  await writeFile(scenarioPath,JSON.stringify(antigravityScenario(["The report's first heading is Quarterly Harbor Report."])),"utf8");
  const instance={id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true};
  const agent=fileURLToPath(new URL("../../tests/fixtures/scripted-acp-agent.mjs",import.meta.url));
  const childEnv={...process.env,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TREBELL_ACP_SCENARIO:scenarioPath,TREBELL_ACP_LOG:logPath};
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"home")});
  const seed=threadStore.create({runtime:"antigravity",cwd:root,providerSessionId:"",model:MODEL,name:"Report check"});
  // The relay runs in the GUI server's process and shares its home, here the mock server's, where the uploads and their text are.
  const runtimeManager={
    activeRuntime:()=>"antigravity",activeInstance:()=>instance,instances:()=>[instance],compatibleInstanceIds:()=>[instance.id],
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...childEnv}),executable:()=>process.execPath,acpArgs:()=>[agent],
    probe:async()=>({id:instance.id,name:"Antigravity",available:true,authenticated:true,version:"1.2.1"}),env:{...process.env,TREBELL_HOME:e2eHome()},
  };
  const meta=new Map([[seed.id,{projectless:true,environmentId:null}]]);
  const state={settings:()=>({activeEnvironmentId:null,continueThreadsAfterRestart:false}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},recordUsage:()=>{}};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:null,state,version:"fixture"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const log=async()=>{try{return (await readFile(logPath,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))}catch{return []}};
  try{
    await keepThreadMeta(page);
    const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"antigravity",agentRuntimeInstanceId:instance.id,modelProvider:"openai",defaultPermissionMode:"auto",defaultWorkspaceMode:"current"};
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"antigravity",agentRuntimeInstanceId:instance.id,agentRuntimeReady:true,appServerReady:true,wsUrl:"ws://127.0.0.1:"+server.address().port+"/api/agent/ws",cwd:root,platform:process.platform,version:"fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{[seed.id]:{projectless:true,environmentId:null}}}));
    await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{agentRuntime:"antigravity",ready:true,models:[MODEL],defaultModel:MODEL,metadata:{models:[{id:MODEL,name:"Gemini 3.8 Flash (High)",agent:"antigravity"}]},error:null}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    await page.getByRole("button",{name:/Report check/}).click();
    await expect(page.getByTestId("composer")).toBeEnabled();
    await attach(page,page.getByRole("button",{name:"Attach files",exact:true}),[{name:"report.docx",mimeType:DOCX,buffer:REPORT},{name:"broken.docx",mimeType:DOCX,buffer:Buffer.from("not a Word document")}]);
    for(const name of ["report.docx","broken.docx"])await expect(page.getByRole("button",{name:"Remove "+name})).toBeVisible({timeout:20_000});
    await send(page,"What is the report's first heading?");
    const reply=page.locator(".assistant-message-text").filter({hasText:"The report's first heading is Quarterly Harbor Report."});
    await expect(reply).toBeVisible({timeout:20_000});
    const prompt=(await log()).find(entry=>entry.method==="session/prompt")?.params?.prompt||[];
    const links=prompt.filter(part=>part.type==="resource_link").map(part=>part.name);
    expect(links.map(name=>name.replace(/^\d{10,}-[0-9a-f]{8}-/,"")),"both documents keep their links").toEqual(["report.docx","broken.docx"]);
    const lines=prompt.filter(part=>part.type==="text"&&/^\[Attached file "/.test(part.text)).map(part=>part.text);
    expect(lines,"only the readable document is named with its text").toHaveLength(1);
    const [,saved,textPath]=/is saved at: (.+report\.docx) \(text extracted to: (.+report\.docx\.txt)\)\]$/.exec(lines[0])||[];
    expect(textPath).toBe(saved+".txt");
    const embedded=prompt.filter(part=>part.type==="resource").map(part=>part.resource);
    expect(embedded.map(resource=>[resource.mimeType,resource.text]),"its text goes embedded, as Antigravity cannot open Trebell's attachments folder").toEqual([["text/plain",REPORT_TEXT]]);
    expect(prompt.indexOf(prompt.find(part=>part.type==="resource"))).toBe(prompt.findIndex(part=>part.type==="text"&&part.text===lines[0])+1);
    await shots(page,"antigravity-message-with-documents",()=>expect(reply).toBeVisible());
  }finally{
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));threadStore.close();
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});
