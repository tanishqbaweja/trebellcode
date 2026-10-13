import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";

// Approvals and questions an agent asks, answered as a person does. A Codex app-server is faked behind the real Codex relay: it lists
// two threads and sends server requests as Codex does, and every answer the app gives is kept, a duplicate included.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const now=Date.now()/1000;
const RELEASE={id:"requests-release",name:"Release checklist",preview:"Release",historyMode:"paginated",cwd:process.cwd(),createdAt:now-20,updatedAt:now,turns:[]};
const DEPLOY={id:"requests-deploy",name:"Deploy notes",preview:"Deploy",historyMode:"paginated",cwd:process.cwd(),createdAt:now-40,updatedAt:now-10,turns:[]};
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

async function startRequestHarness(threads){
  let socket=null,nextId=5000;const answers=new Map(),waiting=new Map(),sockets=new Set();
  const upstreamHttp=createServer(),wss=new WebSocketServer({noServer:true});
  upstreamHttp.on("upgrade",(req,raw,head)=>wss.handleUpgrade(req,raw,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);socket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));
      if(message.id!=null&&!message.method){const id=String(message.id);answers.set(id,[...(answers.get(id)||[]),message.result]);waiting.get(id)?.(message.result);waiting.delete(id);return}
      if(message.id==null||!message.method)return;
      const params=message.params||{};let result={};
      if(message.method==="initialize")result={userAgent:"agent-requests-fixture"};
      else if(message.method==="thread/list")result={data:threads,nextCursor:null};
      else if(message.method==="thread/resume")result={thread:threads.find(thread=>thread.id===params.threadId)||threads[0],itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(["thread/attachment/list","thread/queue/list","threadSection/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",
    // A server request as Codex sends it; answered resolves with the app's first answer.
    ask(method,params){const id=nextId++;const answered=new Promise(resolve=>waiting.set(String(id),resolve));socket.send(JSON.stringify({id,method,params}));return {id,answered}},
    answersTo:request=>answers.get(String(request.id))||[],
    async close(){relay.close();for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])},
  };
}
async function routeFixture(page,harness){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  // The settings the header's light and dark toggle saves stay in the page, so the shared e2e server keeps its own.
  const saved={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  await keepThreadMeta(page);
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return json(route,saved)});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"agent-requests-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:saved,projects:[],threadMeta:{[RELEASE.id]:{projectless:true,environmentId:null},[DEPLOY.id]:{projectless:true,environmentId:null}}}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
}
async function openThread(page,name){
  await page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)}).locator(".thread-main").click();
  await expect(page.locator(".workspace-header")).toContainText(name);
  await expect(page.getByTestId("composer")).toHaveAttribute("placeholder","Ask Trebell Code anything…");
}
// The header's light and dark toggle, or its row in More actions where the header folded it away.
async function toggleMode(page){
  const before=await page.locator("html").getAttribute("data-mode"),direct=page.locator("[data-testid=appearance-toggle]:visible").first();
  if(await direct.count())await direct.click();
  else{await page.getByRole("button",{name:/More actions/}).first().click();await page.getByRole("menuitem",{name:/Switch to (light|dark) mode/}).first().click()}
  await expect(page.locator("html")).not.toHaveAttribute("data-mode",before||"");
}
// Screenshots at 1280x800 and 900 wide in the mode the page is in. A modal covers the header's light and dark toggle, so a test runs
// its steps once in each mode, switching with the toggle between the runs.
async function shoot(page,name){
  for(const [width,height] of [[1280,800],[900,800]]){
    await page.setViewportSize({width,height});
    const mode=await page.locator("html").getAttribute("data-mode");
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({animations:"disabled",path:`${auditDir}agent-requests-${name}-${mode}-${width}x${height}.png`});
  }
  await page.setViewportSize({width:1280,height:800});
}
const textFile=(name,text)=>({name,mimeType:"text/plain",buffer:Buffer.from(text+"\n")});

test("every agent question waits for its own answer, one at a time, naming the thread that asked when it is not the open one",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    for(const pass of ["dark","light"]){
      if(pass==="light")await toggleMode(page);
      const modal=page.locator(".question-modal");
      const first=harness.ask("item/tool/requestUserInput",{threadId:RELEASE.id,turnId:"turn-release",itemId:"q-env-"+pass,questions:[{id:"env",header:"Target",question:"Which environment should I deploy to?",options:[{label:"dev"},{label:"staging"}],allowMultiple:false}]});
      await expect(modal).toContainText("Which environment should I deploy to?");
      await expect(modal.getByTestId("question-thread")).toHaveCount(0);
      await modal.getByRole("button",{name:"dev",exact:true}).click();
      // A second thread's question waits behind the first, which keeps the person's choice.
      const second=harness.ask("item/tool/requestUserInput",{threadId:DEPLOY.id,turnId:"turn-deploy",itemId:"q-port-"+pass,questions:[{id:"port",header:"Port",question:"Which port should the server use?",options:[{label:"8080"},{label:"3000"}],allowMultiple:false}]});
      await expect(modal).toContainText("1 more waiting");
      await expect(modal).toContainText("Which environment should I deploy to?");
      await expect(modal.getByRole("button",{name:"dev",exact:true})).toHaveAttribute("aria-pressed","true");
      if(pass==="dark")await shoot(page,"question-with-one-waiting");
      await modal.getByRole("button",{name:"Submit",exact:true}).click();
      expect(await first.answered).toEqual({answers:{env:{answers:["dev"]}}});
      // The next comes at once, named by its thread.
      await expect(modal).toContainText("Which port should the server use?");
      await expect(modal.getByTestId("question-thread")).toHaveText("Waiting in Deploy notes");
      await expect(modal).not.toContainText("more waiting");
      await shoot(page,"question-from-another-thread");
      // A third arrives while the second shows; dismissing the second shows the third.
      const third=harness.ask("item/tool/requestUserInput",{threadId:RELEASE.id,turnId:"turn-release",itemId:"q-notes-"+pass,questions:[{id:"notes",header:"Notes",question:"Anything to add to the release notes?",options:[],allowMultiple:false}]});
      await expect(modal).toContainText("1 more waiting");
      await modal.getByRole("button",{name:"Cancel",exact:true}).click();
      expect(await second.answered).toEqual({answers:{}});
      await expect(modal).toContainText("Anything to add to the release notes?");
      await expect(modal.getByTestId("question-thread")).toHaveCount(0);
      await modal.getByPlaceholder("Custom answer…").click();await page.keyboard.type("Ship on Friday",{delay:8});
      await modal.getByRole("button",{name:"Submit",exact:true}).click();
      expect(await third.answered).toEqual({answers:{notes:{answers:["Ship on Friday"]}}});
      await expect(modal).toHaveCount(0);
      for(const request of [first,second,third])expect(harness.answersTo(request)).toHaveLength(1);
    }
  }finally{await harness.close()}
});

test("a double click on Allow once answers only the approval it was aimed at, and the next waits for its own decision",async({page})=>{
  test.setTimeout(45_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    const approval=(itemId,reason)=>harness.ask("item/commandExecution/requestApproval",{threadId:RELEASE.id,turnId:"turn-release",itemId,command:["npm","run",itemId],reason});
    const card=reason=>page.locator(".inline-approval .approval-card").filter({hasText:reason});
    const first=approval("build","Build the release bundle");
    await expect(card("Build the release bundle")).toBeVisible();
    const second=approval("publish","Publish the release to npm");
    await page.waitForTimeout(300);
    await card("Build the release bundle").getByRole("button",{name:"Allow once",exact:true}).dblclick();
    expect(await first.answered).toEqual({decision:"accept"});
    // The second card comes up under the pointer and keeps its own decision: the double click's second click is not taken for it.
    await expect(card("Publish the release to npm")).toBeVisible();
    await page.waitForTimeout(600);
    expect(harness.answersTo(first)).toHaveLength(1);
    expect(harness.answersTo(second)).toHaveLength(0);
    await card("Publish the release to npm").getByRole("button",{name:"Deny",exact:true}).click();
    expect(await second.answered).toEqual({decision:"decline"});
    await expect(page.locator(".inline-approval .approval-card")).toHaveCount(0);
    expect(harness.answersTo(second)).toHaveLength(1);
  }finally{await harness.close()}
});

test("a question's Submit waits until every part of it has an answer",async({page})=>{
  test.setTimeout(45_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    for(const pass of ["dark","light"]){
      if(pass==="light")await toggleMode(page);
      const modal=page.locator(".question-modal"),submit=modal.getByRole("button",{name:"Submit",exact:true});
      const asked=harness.ask("item/tool/requestUserInput",{threadId:RELEASE.id,turnId:"turn-release",itemId:"q-two-"+pass,questions:[
        {id:"env",header:"Target",question:"Which environment should I deploy to?",options:[{label:"dev"},{label:"staging"}],allowMultiple:false},
        {id:"owner",header:"Owner",question:"Who signs off on the release?",options:[],allowMultiple:false}]});
      await expect(modal).toContainText("Who signs off on the release?");
      await expect(submit).toBeDisabled();
      if(pass==="dark")await shoot(page,"question-unanswered");
      await modal.getByRole("button",{name:"staging",exact:true}).click();
      await expect(submit).toBeDisabled();
      await modal.getByPlaceholder("Custom answer…").nth(1).click();await page.keyboard.type("Dana",{delay:8});
      await expect(submit).toBeEnabled();
      await shoot(page,"question-answered");
      // Clearing a part again takes Submit away again.
      for(let index=0;index<4;index++)await page.keyboard.press("Backspace");
      await expect(submit).toBeDisabled();
      await page.keyboard.type("Dana",{delay:8});
      await submit.click();
      expect(await asked.answered).toEqual({answers:{env:{answers:["staging"]},owner:{answers:["Dana"]}}});
      await expect(modal).toHaveCount(0);
    }
  }finally{await harness.close()}
});

test("files attached in a question go with its answer only, and its 100-file cap counts only its own files",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    const shelf=page.locator(".attachment-shelf span");
    const choose=async(button,files)=>{const [chooser]=await Promise.all([page.waitForEvent("filechooser"),button.click()]);await chooser.setFiles(files)};
    await choose(page.getByRole("button",{name:"Attach files",exact:true}),[textFile("composer-a.txt","a"),textFile("composer-b.txt","b"),textFile("composer-c.txt","c")]);
    await expect(shelf).toHaveCount(3);
    const modal=page.locator(".question-modal");
    const asked=harness.ask("item/tool/requestUserInput",{threadId:RELEASE.id,turnId:"turn-release",itemId:"q-files",questions:[{id:"evidence",header:"Evidence",question:"Attach the failing logs?",options:[],allowMultiple:false}]});
    await expect(modal).toContainText("Attach the failing logs?");
    await choose(modal.getByRole("button",{name:"Attach files"}),[textFile("build.log","build failed"),textFile("test.log","3 tests failed")]);
    await expect(modal.locator(".question-files span")).toHaveCount(2);
    await expect(modal).toContainText("2/100 attached");
    await modal.getByRole("button",{name:"Submit",exact:true}).click();
    const answer=(await asked.answered).answers.evidence.answers;
    expect(answer).toHaveLength(1);
    expect(answer[0]).toMatch(/^Attached files:\n- .*build\.log\n- .*test\.log$/);
    await expect(modal).toHaveCount(0);
    // The composer keeps its own three files and nothing else.
    await expect(shelf).toHaveCount(3);
    await expect(page.locator(".attachment-shelf")).not.toContainText("build.log");
    // A later question's pick of 101 files keeps 100: the composer's files are not counted against it.
    const next=harness.ask("item/tool/requestUserInput",{threadId:RELEASE.id,turnId:"turn-release",itemId:"q-many",questions:[{id:"logs",header:"Logs",question:"Attach every worker log?",options:[],allowMultiple:false}]});
    await expect(modal).toContainText("Attach every worker log?");
    await choose(modal.getByRole("button",{name:"Attach files"}),Array.from({length:101},(_,index)=>textFile(`worker-${index+1}.log`,"worker "+(index+1))));
    await expect(modal).toContainText("100/100 attached",{timeout:30_000});
    await expect(modal.getByRole("button",{name:"Attach files"})).toBeDisabled();
    await shoot(page,"question-full-of-files");
    await modal.getByRole("button",{name:"Submit",exact:true}).click();
    expect((await next.answered).answers.logs.answers[0].split("\n- ")).toHaveLength(101);
    await expect(shelf).toHaveCount(3);
    await shoot(page,"composer-after-question-files");
    await toggleMode(page);await shoot(page,"composer-after-question-files");
  }finally{await harness.close()}
});

// A question's pick where one file is refused for its size (an image over 10 MB) keeps the file it took, as the composer does: that
// file goes with the answer, the refusal is said in the question, and nothing goes to the composer's shelf.
test("a question keeps the file it took from a pick where another file is refused for its size, and says what it refused",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    const uploads=[];page.on("request",request=>{if(/\/api\/attachments\/blob$/.test(request.url()))uploads.push(request.url())});
    const modal=page.locator(".question-modal");
    const asked=harness.ask("item/tool/requestUserInput",{threadId:RELEASE.id,turnId:"turn-release",itemId:"q-refused",questions:[{id:"evidence",header:"Evidence",question:"Attach the failing logs?",options:[],allowMultiple:false}]});
    await expect(modal).toContainText("Attach the failing logs?");
    const [chooser]=await Promise.all([page.waitForEvent("filechooser"),modal.getByRole("button",{name:"Attach files"}).click()]);
    await chooser.setFiles([textFile("build.log","build failed"),{name:"screen.png",mimeType:"image/png",buffer:Buffer.alloc(11*1024*1024,1)}]);
    await expect(modal.locator(".inline-error")).toHaveText("Could not attach files: screen.png: Image is larger than 10 MB",{timeout:15_000});
    await expect(modal.locator(".question-files span")).toHaveCount(1);await expect(modal.locator(".question-files")).toContainText("build");
    await expect(modal).toContainText("1/100 attached");
    expect(uploads).toHaveLength(1);
    await expect(page.locator(".attachment-shelf span")).toHaveCount(0);
    await shoot(page,"question-file-refused-for-size");
    await modal.getByRole("button",{name:"Submit",exact:true}).click();
    expect((await asked.answered).answers.evidence.answers[0]).toMatch(/^Attached files:\n- .*build\.log$/);
  }finally{await harness.close()}
});

// A double click whose pointer moves a few pixels between its clicks is two single clicks to the browser (detail 1 each), as Windows
// makes it when the pointer leaves its double-click rectangle: the second still lands on the next card, which came up under the
// pointer, and is not taken for it.
test("a double click on Allow once that moves a few pixels approves only the card it was aimed at",async({page})=>{
  test.setTimeout(45_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    const card=reason=>page.locator(".inline-approval .approval-card").filter({hasText:reason});
    const first=harness.ask("item/commandExecution/requestApproval",{threadId:RELEASE.id,turnId:"turn-release",itemId:"build",command:["npm","run","build"],reason:"Build the release bundle"});
    await expect(card("Build the release bundle")).toBeVisible();
    const second=harness.ask("item/commandExecution/requestApproval",{threadId:RELEASE.id,turnId:"turn-release",itemId:"publish",command:["npm","publish"],reason:"Publish the release to npm"});
    await page.waitForTimeout(300);
    const box=await card("Build the release bundle").getByRole("button",{name:"Allow once",exact:true}).boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
    await page.mouse.click(x,y);await page.waitForTimeout(90);await page.mouse.click(x+6,y+1);
    expect(await first.answered).toEqual({decision:"accept"});
    await expect(card("Publish the release to npm")).toBeVisible();
    await page.waitForTimeout(600);
    expect(harness.answersTo(second),"the second click of the double click approved the next, unseen request").toHaveLength(0);
    await card("Publish the release to npm").getByRole("button",{name:"Allow once",exact:true}).click();
    expect(await second.answered).toEqual({decision:"accept"});
  }finally{await harness.close()}
});

// Each question gets a modal of its own: a double click on Cancel, or Enter pressed twice on it, dismisses the question shown, and the
// next one, from this thread or another, waits for the person.
test("a double click or Enter pressed twice on a question's Cancel dismisses only that question, and the next waits for the person",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    const modal=page.locator(".question-modal");
    const question=(threadId,itemId,id,text,labels)=>harness.ask("item/tool/requestUserInput",{threadId,turnId:"turn-"+threadId,itemId,questions:[{id,header:id,question:text,options:labels.map(label=>({label})),allowMultiple:false}]});
    const first=question(RELEASE.id,"q-env","env","Which environment should I deploy to?",["dev","staging"]);
    await expect(modal).toContainText("Which environment should I deploy to?");
    const second=question(RELEASE.id,"q-region","region","Which region should I deploy to?",["eu","us"]);
    await expect(modal).toContainText("1 more waiting");
    await modal.getByRole("button",{name:"Cancel",exact:true}).dblclick({delay:20});
    expect(await first.answered).toEqual({answers:{}});
    await expect(modal).toContainText("Which region should I deploy to?");
    await page.waitForTimeout(600);
    expect(harness.answersTo(second),"the second click of the double click dismissed the next question unseen").toHaveLength(0);
    // From the keyboard: Tab to Cancel and press Enter twice; the next question, from another thread, keeps waiting.
    const third=question(DEPLOY.id,"q-port","port","Which port should the server use?",["8080","3000"]);
    await expect(modal).toContainText("1 more waiting");
    for(let index=0;index<20&&await page.evaluate(()=>document.activeElement?.textContent?.trim())!=="Cancel";index++)await page.keyboard.press("Tab");
    expect(await page.evaluate(()=>document.activeElement?.textContent?.trim())).toBe("Cancel");
    await page.keyboard.press("Enter");await page.waitForTimeout(80);await page.keyboard.press("Enter");
    expect(await second.answered).toEqual({answers:{}});
    await expect(modal).toContainText("Which port should the server use?");await expect(modal.getByTestId("question-thread")).toHaveText("Waiting in Deploy notes");
    await page.waitForTimeout(600);
    expect(harness.answersTo(third),"the second Enter dismissed the next question, from another thread, unseen").toHaveLength(0);
    await modal.getByRole("button",{name:"8080",exact:true}).click();await modal.getByRole("button",{name:"Submit",exact:true}).click();
    expect(await third.answered).toEqual({answers:{port:{answers:["8080"]}}});
    await expect(modal).toHaveCount(0);
  }finally{await harness.close()}
});
