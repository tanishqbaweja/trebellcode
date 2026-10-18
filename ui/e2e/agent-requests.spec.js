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

// calls: the methods the app asked for, in order.
async function startRequestHarness(threads){
  let socket=null,nextId=5000;const answers=new Map(),waiting=new Map(),sockets=new Set(),calls=[];
  const upstreamHttp=createServer(),wss=new WebSocketServer({noServer:true});
  upstreamHttp.on("upgrade",(req,raw,head)=>wss.handleUpgrade(req,raw,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);socket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));
      if(message.id!=null&&!message.method){const id=String(message.id);answers.set(id,[...(answers.get(id)||[]),message.result]);waiting.get(id)?.(message.result);waiting.delete(id);return}
      if(message.id==null||!message.method)return;
      const params=message.params||{};let result={};calls.push(message.method);
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
    // A notification as Codex sends it.
    notify(method,params){socket.send(JSON.stringify({method,params}))},
    answersTo:request=>answers.get(String(request.id))||[],calls,
    async close(){relay.close();for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])},
  };
}
// settings adds to the app's settings.
async function routeFixture(page,harness,settings={}){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  // The settings the header's light and dark toggle saves stay in the page, so the shared e2e server keeps its own.
  const saved={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",...settings};
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
  else{await page.getByRole("button",{name:/More actions/}).first().click();await page.getByTestId("header-overflow-menu").getByRole("button",{name:/^Switch to (light|dark) mode$/}).click()}
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

// A card's main button keeps its look under the pointer, as the dialogs' does: Allow once its accent fill and an auto review
// denial's Allow anyway its red tint, a shade deeper, in light mode as in dark, while Deny and Dismiss turn a shade darker.
test("under the pointer Allow once keeps its accent fill and Allow anyway its red tint, in light mode as in dark",async({page})=>{
  test.setTimeout(45_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  // A button's fill (its gradient, or its colour), text colour and filter, and whether a fill is a red tint.
  const look=button=>button.evaluate(node=>{const style=getComputedStyle(node);return {fill:style.backgroundImage==="none"?style.backgroundColor:style.backgroundImage,text:style.color,filter:style.filter}});
  const red=fill=>{const [r,g,b]=(fill.match(/[\d.]+/g)||[]).map(Number);return r>g&&r>b};
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    for(const pass of ["dark","light"]){
      if(pass==="light")await toggleMode(page);
      const request=harness.ask("item/commandExecution/requestApproval",{threadId:RELEASE.id,turnId:"turn-release",itemId:"tests-"+pass,command:["npm","test"],reason:"Run the unit tests"});
      const card=page.locator(".inline-approval .approval-card").filter({hasText:"Run the unit tests"});await expect(card).toBeVisible();
      const allow=card.getByRole("button",{name:"Allow once",exact:true}),deny=card.getByRole("button",{name:"Deny",exact:true});
      await page.mouse.move(1,1);const accent=await look(allow),plain=await look(deny);
      expect(accent.fill).toContain("gradient");
      await allow.hover();
      await expect.poll(()=>look(allow)).toEqual({...accent,filter:"brightness(1.1)"});
      await page.screenshot({animations:"disabled",path:`${auditDir}agent-requests-allow-once-hovered-${pass}-1280x800.png`});
      await deny.hover();await expect.poll(async()=>(await look(deny)).fill).not.toBe(plain.fill);
      await deny.click();expect(await request.answered).toEqual({decision:"decline"});await expect(card).toHaveCount(0);

      const startedAt=Date.now(),action={type:"command",source:"unifiedExec",command:"rm generated-"+pass+".tmp",cwd:process.cwd()};
      harness.notify("item/autoApprovalReview/started",{threadId:RELEASE.id,turnId:"turn-release",startedAtMs:startedAt,reviewId:"review-"+pass,targetItemId:"cmd-"+pass,review:{status:"inProgress",riskLevel:null,userAuthorization:null,rationale:null},action});
      harness.notify("item/autoApprovalReview/completed",{threadId:RELEASE.id,turnId:"turn-release",startedAtMs:startedAt,completedAtMs:startedAt+120,reviewId:"review-"+pass,targetItemId:"cmd-"+pass,decisionSource:"agent",review:{status:"denied",riskLevel:"high",userAuthorization:"low",rationale:"Deleting this file needs explicit user approval."},action});
      const denial=page.getByTestId("guardian-denial-card");await expect(denial).toContainText("rm generated-"+pass+".tmp");
      const anyway=denial.getByRole("button",{name:"Allow anyway",exact:true}),dismiss=denial.getByRole("button",{name:"Dismiss",exact:true});
      await page.mouse.move(1,1);const tint=await look(anyway),quiet=await look(dismiss);
      expect(red(tint.fill)).toBe(true);
      await anyway.hover();
      await expect.poll(async()=>{const now=await look(anyway);return {text:now.text,red:red(now.fill),deeper:now.fill!==tint.fill}}).toEqual({text:tint.text,red:true,deeper:true});
      await page.screenshot({animations:"disabled",path:`${auditDir}agent-requests-allow-anyway-hovered-${pass}-1280x800.png`});
      await dismiss.hover();await expect.poll(async()=>(await look(dismiss)).fill).not.toBe(quiet.fill);
      await dismiss.click();await expect(denial).toHaveCount(0);
    }
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

// Escape dismisses a question as Cancel does, with the keyboard on the dialog, in one of its fields or on the page behind it; in a
// question the app asks over it (Rename) Escape is that question's. Only a press of its own counts: pressed twice, or held down, it
// dismisses the question shown, and the next, which comes up in its place, waits for the person.
test("Escape dismisses an agent question as Cancel does, and pressed twice or held down dismisses only the question shown",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    const modal=page.locator(".question-modal");
    const question=(threadId,itemId,id,text)=>harness.ask("item/tool/requestUserInput",{threadId,turnId:"turn-"+threadId,itemId,questions:[{id,header:id,question:text,options:[{label:"yes"},{label:"no"}],allowMultiple:false}]});
    // A person reads a question before pressing Escape on it: a press within 500 ms of the Escape before it is that one's second.
    const read=()=>page.waitForTimeout(600);
    for(const [pass,width] of [["dark",1280],["light",900]]){
      if(pass==="light")await toggleMode(page);
      await page.setViewportSize({width,height:800});
      const first=question(RELEASE.id,"q-region-"+pass,"region","Which region should I deploy to?");
      await expect(modal).toContainText("Which region should I deploy to?");await expect(modal).toBeFocused();
      await read();await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);expect(await first.answered).toEqual({answers:{}});
      // From its field, with another question waiting: Escape pressed twice dismisses this one only.
      const second=question(RELEASE.id,"q-env-"+pass,"env","Which environment should I deploy to?"),third=question(DEPLOY.id,"q-port-"+pass,"port","Which port should the server use?");
      await expect(modal).toContainText("1 more waiting");
      await modal.getByPlaceholder("Custom answer…").click();await page.keyboard.type("staging",{delay:8});
      await read();await page.keyboard.press("Escape");await page.keyboard.press("Escape");
      expect(await second.answered).toEqual({answers:{}});
      await expect(modal).toContainText("Which port should the server use?");await expect(modal.getByTestId("question-thread")).toHaveText("Waiting in Deploy notes");
      await page.waitForTimeout(600);
      expect(harness.answersTo(third),"the second Escape dismissed the next question unseen").toHaveLength(0);
      await shoot(page,"question-after-escape-twice");await page.setViewportSize({width,height:800});
      // Held down, it dismisses the question shown, and its repeats leave the next one waiting.
      const fourth=question(RELEASE.id,"q-notes-"+pass,"notes","Anything to add to the release notes?");
      await expect(modal).toContainText("1 more waiting");
      await page.keyboard.down("Escape");
      expect(await third.answered).toEqual({answers:{}});
      await expect(modal).toContainText("Anything to add to the release notes?");
      await page.keyboard.down("Escape");await page.keyboard.down("Escape");await page.keyboard.up("Escape");
      await page.waitForTimeout(600);
      expect(harness.answersTo(fourth),"the held Escape's repeats dismissed the next question unseen").toHaveLength(0);
      // With the keyboard on the page behind it, where a click on the dimmed area leaves it.
      await page.mouse.click(12,400);expect(await page.evaluate(()=>document.activeElement===document.body)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);expect(await fourth.answered).toEqual({answers:{}});
      for(const request of [first,second,third,fourth])expect(harness.answersTo(request)).toHaveLength(1);
    }
    // A question the app asks over it keeps its own Escape: it closes Rename, and the agent's question waits for the next.
    await page.setViewportSize({width:1280,height:800});
    await page.locator(".workspace-header .thread-title-button").click();
    const rename=page.locator("dialog.inspector-text-prompt");await expect(rename).toContainText("Rename thread");
    const fifth=question(RELEASE.id,"q-owner","owner","Who signs off on the release?");
    await expect(modal).toContainText("Who signs off on the release?");
    await page.keyboard.press("Escape");
    await expect(rename).toHaveCount(0);await page.waitForTimeout(600);
    expect(harness.answersTo(fifth),"Escape in Rename dismissed the agent's question too").toHaveLength(0);
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);expect(await fifth.answered).toEqual({answers:{}});
  }finally{await harness.close()}
});

// Escape cancels an app request as its X does, with the keyboard on the dialog, in a field of its form or on the page behind it. Only
// a press of its own counts: pressed twice, or held down, it cancels the request shown, and the next waits for the person.
test("Escape cancels an app request as its X does, and pressed twice or held down cancels only the request shown",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    const modal=page.getByTestId("mcp-elicitation"),dialog=modal.getByRole("dialog"),cancelled={action:"cancel",content:null,_meta:null};
    const ask=params=>harness.ask("mcpServer/elicitation/request",{threadId:RELEASE.id,serverName:"fixture_app",...params});
    const approval=title=>ask({mode:"form",message:"Approve the fixture change?",requestedSchema:{type:"object",properties:{}},_meta:{codex_approval_kind:"mcp_tool_call",connector_name:"Fixture App",tool_title:title,tool_name:"fixture_action"}});
    // A person reads a request before pressing Escape on it: a press within 500 ms of the Escape before it is that one's second.
    const read=()=>page.waitForTimeout(600);
    for(const [pass,width] of [["dark",1280],["light",900]]){
      if(pass==="light")await toggleMode(page);
      await page.setViewportSize({width,height:800});
      const write=approval("Write fixture");
      await expect(modal).toContainText("Write fixture");await expect(dialog).toBeFocused();
      await read();await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);expect(await write.answered).toEqual(cancelled);
      // A form, from the field being filled in.
      const form=ask({mode:"form",message:"Name the deployment",requestedSchema:{type:"object",required:["label"],properties:{label:{type:"string",title:"Deployment name"}}}});
      await expect(modal).toContainText("Name the deployment");
      await modal.locator(".mcp-field").filter({hasText:"Deployment name"}).locator("input").click();await page.keyboard.type("canary",{delay:8});
      await read();await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);expect(await form.answered).toEqual(cancelled);
      // Pressed twice with two more waiting, it cancels the request shown only; held down, its repeats leave the next one waiting.
      const remove=approval("Delete fixture"),rename=approval("Rename fixture"),link=ask({mode:"url",elicitationId:"sign-in-"+pass,url:"https://auth.example.test/connect",message:"Sign in to the fixture service."});
      await expect(modal).toContainText("Delete fixture");await expect(dialog).toBeFocused();
      await read();await page.keyboard.press("Escape");await page.keyboard.press("Escape");
      expect(await remove.answered).toEqual(cancelled);
      await expect(modal).toContainText("Rename fixture");await page.waitForTimeout(600);
      expect(harness.answersTo(rename),"the second Escape cancelled the next request unseen").toHaveLength(0);
      await shoot(page,"app-request-after-escape-twice");await page.setViewportSize({width,height:800});
      await page.keyboard.down("Escape");
      expect(await rename.answered).toEqual(cancelled);
      await expect(modal).toContainText("Sign in to the fixture service.");
      await page.keyboard.down("Escape");await page.keyboard.down("Escape");await page.keyboard.up("Escape");
      await page.waitForTimeout(600);
      expect(harness.answersTo(link),"the held Escape's repeats cancelled the next request unseen").toHaveLength(0);
      // With the keyboard on the page behind it, where a click on the dimmed area leaves it.
      await page.mouse.click(12,400);expect(await page.evaluate(()=>document.activeElement===document.body)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);expect(await link.answered).toEqual(cancelled);
      for(const request of [write,form,remove,rename,link])expect(harness.answersTo(request)).toHaveLength(1);
    }
  }finally{await harness.close()}
});

// The Escape that answers the last request goes no further: with Stop running thread bound to Escape, the Escape that dismisses the
// question a running turn asked, or cancels its app request, does not stop the turn as well. With no request open, Escape stops it.
test("Escape that answers the last request runs no shortcut bound to Escape as well, so the turn that asked keeps running",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness,{keybindingRules:[{command:"threadStop",key:"Escape"}]});await page.goto("/");await openThread(page,"Release checklist");
    const stop=page.getByRole("button",{name:"Stop",exact:true}),interrupts=()=>harness.calls.filter(method=>method==="turn/interrupt");
    const questionModal=page.locator(".question-modal"),appModal=page.getByTestId("mcp-elicitation");
    // A person reads a request before pressing Escape on it.
    const read=()=>page.waitForTimeout(600);
    harness.notify("turn/started",{threadId:RELEASE.id,turn:{id:"turn-asking",status:"inProgress",items:[]}});await expect(stop).toBeVisible();
    const asked=harness.ask("item/tool/requestUserInput",{threadId:RELEASE.id,turnId:"turn-asking",itemId:"q-go",questions:[{id:"go",header:"go",question:"Go ahead with the release?",options:[{label:"yes"},{label:"no"}],allowMultiple:false}]});
    await expect(questionModal).toContainText("Go ahead with the release?");await read();await page.keyboard.press("Escape");
    await expect(questionModal).toHaveCount(0);expect(await asked.answered).toEqual({answers:{}});
    await page.waitForTimeout(600);
    expect(interrupts(),"the Escape that dismissed the question stopped the turn too").toEqual([]);await expect(stop).toBeVisible();
    const app=harness.ask("mcpServer/elicitation/request",{threadId:RELEASE.id,serverName:"fixture_app",mode:"form",message:"Approve the fixture change?",requestedSchema:{type:"object",properties:{}},_meta:{codex_approval_kind:"mcp_tool_call",connector_name:"Fixture App",tool_title:"Write fixture",tool_name:"fixture_action"}});
    await expect(appModal).toContainText("Write fixture");await read();await page.keyboard.press("Escape");
    await expect(appModal).toHaveCount(0);expect(await app.answered).toEqual({action:"cancel",content:null,_meta:null});
    await page.waitForTimeout(600);
    expect(interrupts(),"the Escape that cancelled the app request stopped the turn too").toEqual([]);await expect(stop).toBeVisible();
    // With no request open, Escape is the person's shortcut: it stops the turn.
    await page.keyboard.press("Escape");
    await expect.poll(interrupts).toEqual(["turn/interrupt"]);
  }finally{await harness.close()}
});

// The agent's question and the app request a test asks; an app request shows its tool's title.
const askQuestion=(harness,id,text)=>harness.ask("item/tool/requestUserInput",{threadId:RELEASE.id,turnId:"turn-"+RELEASE.id,itemId:"q-"+id,questions:[{id,header:id,question:text,options:[{label:"yes"},{label:"no"}],allowMultiple:false}]});
const askApproval=(harness,title)=>harness.ask("mcpServer/elicitation/request",{threadId:RELEASE.id,serverName:"fixture_app",mode:"form",message:"Approve the fixture change?",requestedSchema:{type:"object",properties:{}},_meta:{codex_approval_kind:"mcp_tool_call",connector_name:"Fixture App",tool_title:title,tool_name:"fixture_action"}});
// A person's double click on a button: its first click, then its second at the same spot once the page shows what the first did
// (shown), with nothing selected before it.
async function doubleClick(page,button,shown){
  const box=await button.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.up();await shown();
  await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});
}
const selectedText=page=>page.evaluate(()=>String(getSelection()));

// A double click on the answer to the last request answers it once, and its second click, which lands on the page behind once the
// dialog has gone, does nothing there: no word under the pointer is selected and nothing there is pressed. An app request's Allow once
// and Cancel tool, an agent question's Submit and Cancel, at 1280 and 900 wide. Each is checked whatever the one before it did.
test("a double click that answers the last request, Allow once on an app request or Submit on a question, selects nothing on the page behind",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    const app=page.getByTestId("mcp-elicitation"),modal=page.locator(".question-modal"),composer=page.getByTestId("composer"),asked=[];
    for(const [pass,width] of [["dark",1280],["light",900]]){
      if(pass==="light")await toggleMode(page);
      await page.setViewportSize({width,height:800});
      for(const [button,answer] of [["Allow once",{action:"accept",content:null,_meta:null}],["Cancel tool",{action:"cancel",content:null,_meta:null}]]){
        const request=askApproval(harness,button+" fixture "+pass);asked.push(request);
        await expect(app).toContainText(button+" fixture "+pass);
        await doubleClick(page,app.getByRole("button",{name:button,exact:true}),()=>expect(app).toHaveCount(0));
        expect(await request.answered).toEqual(answer);
        expect.soft(await selectedText(page),`the second click of a double click on ${button} selected text on the page behind`).toBe("");
      }
      for(const button of ["Submit","Cancel"]){
        const id=button.toLowerCase()+"-"+pass,request=askQuestion(harness,id,"Tag the release ("+id+")?");asked.push(request);
        await expect(modal).toContainText("Tag the release ("+id+")?");
        if(button==="Submit")await modal.getByRole("button",{name:"yes",exact:true}).click();
        await doubleClick(page,modal.getByRole("button",{name:button,exact:true}),()=>expect(modal).toHaveCount(0));
        expect(await request.answered).toEqual({answers:button==="Submit"?{[id]:{answers:["yes"]}}:{}});
        expect.soft(await selectedText(page),`the second click of a double click on ${button} selected text on the page behind`).toBe("");
      }
      await expect(composer).toHaveValue("");
      if(pass==="dark")await shoot(page,"after-double-click-answers");
    }
    await page.waitForTimeout(600);
    for(const request of asked)expect(harness.answersTo(request)).toHaveLength(1);
  }finally{await harness.close()}
});

// With another app request waiting, the second click of a double click on Allow once lands on that request, which comes up in the
// first's place under the pointer, and does nothing to it: the request waits for its own answer, as the approval cards' and the
// questions' do.
test("a double click on an app request's Allow once leaves the next app request, which comes up under the pointer, waiting for its own answer",async({page})=>{
  test.setTimeout(45_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    const app=page.getByTestId("mcp-elicitation");
    const write=askApproval(harness,"Write fixture"),remove=askApproval(harness,"Delete fixture");
    await expect(app).toContainText("Write fixture");
    await doubleClick(page,app.getByRole("button",{name:"Allow once",exact:true}),()=>expect(app).toContainText("Delete fixture"));
    expect(await write.answered).toEqual({action:"accept",content:null,_meta:null});
    await page.waitForTimeout(600);
    expect(harness.answersTo(remove),"the second click of the double click approved the next request unseen").toHaveLength(0);
    await expect(app).toContainText("Delete fixture");expect(await selectedText(page)).toBe("");
    await shoot(page,"app-request-after-double-click");
    await app.getByRole("button",{name:"Cancel tool",exact:true}).click();
    expect(await remove.answered).toEqual({action:"cancel",content:null,_meta:null});
    await expect(app).toHaveCount(0);
    expect(harness.answersTo(write)).toHaveLength(1);expect(harness.answersTo(remove)).toHaveLength(1);
  }finally{await harness.close()}
});

// A double click on the × of a file attached in a question takes that file away only: the next file, which slides under the pointer
// once the first has gone, stays and goes with the answer, and no text is selected.
test("a double click on the × of a file attached in a question takes away that file only",async({page})=>{
  test.setTimeout(45_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    const modal=page.locator(".question-modal"),files=modal.locator(".question-files > span"),names=numbers=>numbers.map(number=>`worker-${number}.log`);
    const asked=harness.ask("item/tool/requestUserInput",{threadId:RELEASE.id,turnId:"turn-release",itemId:"q-logs",questions:[{id:"logs",header:"Logs",question:"Attach the failing logs?",options:[],allowMultiple:false}]});
    await expect(modal).toContainText("Attach the failing logs?");
    const [chooser]=await Promise.all([page.waitForEvent("filechooser"),modal.getByRole("button",{name:"Attach files"}).click()]);
    await chooser.setFiles(names([1,2,3,4,5]).map(name=>textFile(name,name)));
    await expect(files).toHaveText(names([1,2,3,4,5]));
    await doubleClick(page,files.first().getByRole("button",{name:"Remove attachment"}),()=>expect(files).toHaveText(names([2,3,4,5])));
    await page.waitForTimeout(600);
    await expect(files,"the second click of the double click took away the next file too").toHaveText(names([2,3,4,5]));
    expect(await selectedText(page),"the second click of the double click selected text in the question").toBe("");
    await expect(modal).toContainText("4/100 attached");
    await shoot(page,"question-file-after-double-click");
    await modal.getByRole("button",{name:"Submit",exact:true}).click();
    expect((await asked.answered).answers.logs.answers[0]).toMatch(/^Attached files:\n- .*worker-2\.log\n- .*worker-3\.log\n- .*worker-4\.log\n- .*worker-5\.log$/);
  }finally{await harness.close()}
});

// An Escape answers only a request the person has had time to see: pressed twice on an app request, its second press leaves the
// agent's question that comes up after it waiting. Read, the question is dismissed by the next Escape.
test("Escape pressed twice on an app request leaves the agent's question that comes up after it waiting",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    const questionModal=page.locator(".question-modal"),appModal=page.getByTestId("mcp-elicitation"),read=()=>page.waitForTimeout(600);
    for(const [pass,width] of [["dark",1280],["light",900]]){
      if(pass==="light")await toggleMode(page);
      await page.setViewportSize({width,height:800});
      // A question first, read and dismissed.
      const first=askQuestion(harness,"first-"+pass,"Which branch should I use?");
      await expect(questionModal).toContainText("Which branch should I use?");await read();await page.keyboard.press("Escape");
      expect(await first.answered).toEqual({answers:{}});
      // Escape twice on an app request with a question waiting behind it: the request is cancelled, and the question waits.
      const app=askApproval(harness,"Write fixture "+pass),behind=askQuestion(harness,"behind-"+pass,"Should I tag the release?");
      await expect(appModal).toContainText("Write fixture "+pass);await read();
      await page.keyboard.press("Escape");await page.keyboard.press("Escape");
      expect(await app.answered).toEqual({action:"cancel",content:null,_meta:null});
      await page.waitForTimeout(600);
      expect(harness.answersTo(behind),"the second Escape dismissed the question that came up after the app request").toHaveLength(0);
      await expect(questionModal).toContainText("Should I tag the release?");
      await shoot(page,"question-after-app-request-escape-twice");await page.setViewportSize({width,height:800});
      await page.keyboard.press("Escape");expect(await behind.answered).toEqual({answers:{}});await expect(questionModal).toHaveCount(0);
      for(const request of [first,app,behind])expect(harness.answersTo(request)).toHaveLength(1);
    }
  }finally{await harness.close()}
});

// An Escape pressed just as a request comes up, well after any Escape before it, was meant for what was there before: it answers
// nothing. Read, the request is answered by the next Escape.
for(const kind of ["question","app request"]){
  test(`Escape pressed just as ${kind==="question"?"an agent's question":"an app request"} comes up answers nothing, and once it is read the next Escape answers it`,async({page})=>{
    test.setTimeout(60_000);
    await page.setViewportSize({width:1280,height:800});
    const harness=await startRequestHarness([RELEASE,DEPLOY]);
    try{
      await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
      const modal=kind==="question"?page.locator(".question-modal"):page.getByTestId("mcp-elicitation");
      const answered=kind==="question"?{answers:{}}:{action:"cancel",content:null,_meta:null};
      for(const [pass,width] of [["dark",1280],["light",900]]){
        if(pass==="light")await toggleMode(page);
        await page.setViewportSize({width,height:800});
        await page.waitForTimeout(600);
        const text=(kind==="question"?"Is the changelog ready? ":"Publish changelog ")+pass;
        const sudden=kind==="question"?askQuestion(harness,"sudden-"+pass,text):askApproval(harness,text);
        await modal.filter({hasText:text}).waitFor();await page.keyboard.press("Escape");
        await page.waitForTimeout(600);
        expect(harness.answersTo(sudden),"an Escape pressed as the request came up answered it unseen").toHaveLength(0);
        await expect(modal).toContainText(text);
        await shoot(page,(kind==="question"?"question":"app-request")+"-after-stray-escape");await page.setViewportSize({width,height:800});
        await page.keyboard.press("Escape");expect(await sudden.answered).toEqual(answered);await expect(modal).toHaveCount(0);
        expect(harness.answersTo(sudden)).toHaveLength(1);
      }
    }finally{await harness.close()}
  });
}

// A required multi-select left empty is refused as an empty required field is, by its name, from the mouse and from the keyboard;
// once an option is chosen the form goes with it. The field is marked in both modes: its title and its unchosen options in red.
test("an app form refuses a required multi-select left empty, saying it is required as it does for an empty required field",async({page})=>{
  test.setTimeout(45_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startRequestHarness([RELEASE,DEPLOY]);
  try{
    await routeFixture(page,harness);await page.goto("/");await openThread(page,"Release checklist");
    const modal=page.getByTestId("mcp-elicitation"),targets=modal.getByRole("group",{name:"Targets"}),submit=modal.getByRole("button",{name:"Submit",exact:true}),alert=modal.getByRole("alert");
    const focused=()=>page.evaluate(()=>{const node=document.activeElement;return (node?.type==="checkbox"?node.closest("label"):node)?.textContent?.trim()});
    const tabTo=async name=>{for(let index=0;index<12&&await focused()!==name;index++)await page.keyboard.press("Tab");expect(await focused()).toBe(name)};
    // How the refused field shows: marked, its title in the error colour, and each option left unchosen outlined in the error line.
    const marking=()=>targets.evaluate(group=>{
      const probe=document.createElement("span");probe.style.cssText="border:1px solid var(--errb);color:var(--err)";group.append(probe);
      const errLine=getComputedStyle(probe).borderTopColor,errText=getComputedStyle(probe).color;probe.remove();
      const field=group.closest(".mcp-field"),title=field?.querySelector(".mcp-field-label");
      return {marked:Boolean(field?.classList.contains("invalid")),title:Boolean(title)&&getComputedStyle(title).color===errText,options:[...group.querySelectorAll("label")].map(label=>getComputedStyle(label).borderTopColor===errLine)};
    });
    for(const [pass,width] of [["dark",1280],["light",900]]){
      if(pass==="light")await toggleMode(page);
      await page.setViewportSize({width,height:800});
      const form=harness.ask("mcpServer/elicitation/request",{threadId:RELEASE.id,serverName:"fixture_app",mode:"form",message:"Pick the targets",requestedSchema:{type:"object",required:["targets"],properties:{targets:{type:"array",title:"Targets",items:{type:"string",enum:["web","api"]}}}}});
      await expect(modal).toContainText("Pick the targets");
      if(pass==="dark"){
        await submit.click();
        await expect(alert).toHaveText("Targets is required");await expect(modal.locator(".mcp-field.invalid")).toContainText("Targets");
        await expect.poll(marking).toEqual({marked:true,title:true,options:[true,true]});
        expect(harness.answersTo(form)).toHaveLength(0);
        await shoot(page,"app-form-required-multiselect");
        // Chosen and taken back, it is refused again; chosen, the form goes.
        await targets.getByText("api",{exact:true}).click();await expect(alert).toHaveCount(0);
        await targets.getByText("api",{exact:true}).click();await submit.click();await expect(alert).toHaveText("Targets is required");
        await targets.getByText("web",{exact:true}).click();await submit.click();
      }else{
        // From the keyboard: Enter on Submit, then Space on an option and Enter on Submit again.
        await tabTo("Submit");await page.keyboard.press("Enter");
        await expect(alert).toHaveText("Targets is required");expect(harness.answersTo(form)).toHaveLength(0);
        // Marked as in dark mode: the light theme's option line does not hide the error line.
        await expect.poll(marking).toEqual({marked:true,title:true,options:[true,true]});
        await shoot(page,"app-form-required-multiselect");await page.setViewportSize({width,height:800});
        await tabTo("web");await page.keyboard.press("Space");await expect(targets.getByRole("checkbox",{name:"web"})).toBeChecked();
        await tabTo("Submit");await page.keyboard.press("Enter");
      }
      expect(await form.answered).toEqual({action:"accept",content:{targets:["web"]},_meta:null});
      await expect(modal).toHaveCount(0);expect(harness.answersTo(form)).toHaveLength(1);
    }
  }finally{await harness.close()}
});
