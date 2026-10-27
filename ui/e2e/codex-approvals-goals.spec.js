import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createGuiServer } from "../../src/gui-server.mjs";
import { e2eHome,keepThreadMeta } from "./test-home.js";

// Codex approvals and goals as a person meets them, with the app talking to a Trebell server of the test's own whose Codex relay
// reaches a fake Codex app-server: "Allow session" answers the thread's later commands without asking, a file change's card names
// its files, and /goal sent while a turn runs stops it and starts the goal.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The fake Codex: it lists the test's thread, keeps goals as Codex does (a notification after each change), starts a turn for
// turn/start and ends it on turn/interrupt, and sends server requests as Codex does (ask), keeping every answer it gets back.
async function fakeCodex(thread){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set(),requests=[],answers=new Map(),goals=new Map(),turns=[];let nextId=7000;
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  const send=value=>{for(const ws of sockets)if(ws.readyState===1)ws.send(JSON.stringify(value))};
  const notify=(method,params)=>send({method,params});
  const running=()=>turns.some(turn=>turn.status==="inProgress");
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));
      if(message.id!=null&&!message.method){const id=String(message.id);answers.set(id,[...(answers.get(id)||[]),message.result]);return}
      if(message.id==null||!message.method)return;requests.push(message);
      const params=message.params||{},reply=result=>{if(ws.readyState===1)ws.send(JSON.stringify({id:message.id,result}))},now=Math.floor(Date.now()/1000);
      if(message.method==="initialize")return reply({userAgent:"codex-approvals-goals"});
      if(message.method==="thread/list")return reply({data:[{...thread,status:{type:running()?"active":"idle"}}],nextCursor:null});
      if(message.method==="thread/resume")return reply({thread:{...thread,status:{type:running()?"active":"idle"}},itemsBackwardsCursor:null,turnsBackwardsCursor:null});
      if(message.method==="thread/goal/get")return reply({goal:goals.get(params.threadId)||null});
      if(message.method==="thread/goal/set"){
        const previous=goals.get(params.threadId)||null;
        const goal={threadId:params.threadId,objective:params.objective??previous?.objective,status:params.status??previous?.status??"active",tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:previous?.createdAt??now,updatedAt:now};
        goals.set(params.threadId,goal);notify("thread/goal/updated",{threadId:params.threadId,goal});return reply({goal});
      }
      if(message.method==="thread/goal/clear"){const cleared=goals.delete(params.threadId);if(cleared)notify("thread/goal/cleared",{threadId:params.threadId});return reply({cleared})}
      if(message.method==="turn/start"){
        const turn={id:"codex-turn-"+(turns.length+1),threadId:params.threadId,status:"inProgress",input:params.input||[]};turns.push(turn);
        reply({turn:{id:turn.id,status:"inProgress",items:[],startedAt:now}});notify("turn/started",{threadId:turn.threadId,turn:{id:turn.id,status:"inProgress",items:[]}});return;
      }
      if(message.method==="turn/interrupt"){
        const turn=turns.find(item=>item.id===params.turnId&&item.status==="inProgress");
        if(turn){turn.status="interrupted";notify("turn/completed",{threadId:turn.threadId,turn:{id:turn.id,status:"interrupted",items:[]}})}
        return reply({});
      }
      if(["thread/turns/list","thread/items/list","thread/attachment/list","thread/timeline/list","thread/queue/list","threadSection/list","thread/loaded/list"].includes(message.method))return reply({data:[],nextCursor:null});
      if(["skills/list","collaborationMode/list","experimentalFeature/list","permissionProfile/list","mcpServerStatus/list","app/list","hooks/list"].includes(message.method))return reply({data:[]});
      if(message.method==="thread/unsubscribe")return reply({status:"unsubscribed"});
      reply({});
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {
    port,requests,turns,goals,notify,
    sent:method=>requests.filter(item=>item.method===method).map(item=>item.params||{}),
    ask(method,params){const id=nextId++;send({id,method,params});return {id,answers:()=>answers.get(String(id))||[]}},
    async close(){for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
}

async function startHarness(page,name){
  const home=await mkdtemp(join(e2eHome(),"codex-approvals-goals-")),cwd=join(home,"release-app"),now=Date.now()/1000;
  mkdirSync(cwd,{recursive:true});
  const thread={id:"codex-approvals-goals-thread",name,preview:name,cwd,createdAt:now-60,updatedAt:now,turns:[]};
  const codex=await fakeCodex(thread),port=await freePort();
  const gui=await createGuiServer({port,appPort:codex.port,mock:true,env:{...process.env,TREBELL_HOME:join(home,"home"),CODEX_HOME:join(home,"codex-home"),CLAUDE_CONFIG_DIR:join(home,"claude-config"),OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:"",HARBOR_TELEMETRY:"0"}});
  // What the test's server knows of the thread: a Codex thread in the project folder.
  await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:thread.id,patch:{runtime:"codex",runtimeInstanceId:"codex-default",environmentId:null,cwd}})});
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"};
  await keepThreadMeta(page);
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:gui.url.replace(/^http/,"ws")+"/api/codex/ws",cwd,platform:process.platform,version:"codex-approvals-goals",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/environments$/,route=>json(route,{profiles:[],activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)}).locator(".thread-main").click();
  await expect(page.locator(".workspace-header")).toContainText(name);
  await expect(page.getByTestId("composer")).toHaveAttribute("placeholder","Ask Trebell Code anything…",{timeout:15_000});
  return {codex,gui,thread,cwd,
    async close(){await page.close().catch(()=>{});await gui.close();await codex.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250}).catch(()=>{})}};
}
async function toggleMode(page){
  const before=await page.locator("html").getAttribute("data-mode"),direct=page.locator("[data-testid=appearance-toggle]:visible").first();
  if(await direct.count())await direct.click();
  else{await page.getByRole("button",{name:/More actions/}).first().click();await page.getByTestId("header-overflow-menu").getByRole("button",{name:/^Switch to (light|dark) mode$/}).click()}
  await expect(page.locator("html")).not.toHaveAttribute("data-mode",before||"");
}
// A screenshot in each mode at 1280x800, back in the mode it started in; ready() is what must show before each.
async function shoot(page,name,ready){
  for(let pass=0;pass<2;pass++){
    if(ready)await ready();
    const mode=await page.locator("html").getAttribute("data-mode");
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({animations:"disabled",path:`${auditDir}codex-approvals-goals-${name}-${mode}-1280x800.png`});
    await toggleMode(page);
  }
}
const card=page=>page.locator(".inline-approval .approval-card");

test("after Allow session the thread's next command runs without asking: only the first card shows, and network access still asks",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,"Release checks");const {codex,thread}=harness;
  try{
    const first=codex.ask("item/commandExecution/requestApproval",{threadId:thread.id,turnId:"turn-1",itemId:"cmd-1",command:"npm test",cwd:harness.cwd,startedAtMs:Date.now()});
    await expect(card(page)).toHaveCount(1);await expect(card(page)).toContainText("Command needs approval");await expect(card(page)).toContainText("npm test");
    await shoot(page,"first-command",()=>expect(card(page)).toBeVisible());
    await card(page).getByRole("button",{name:"Allow session",exact:true}).click();
    await expect.poll(()=>first.answers()).toEqual([{decision:"acceptForSession"}]);
    await expect(card(page)).toHaveCount(0);
    // The next command in the thread: Trebell answers it as allowed for the session, and no card comes for it.
    const second=codex.ask("item/commandExecution/requestApproval",{threadId:thread.id,turnId:"turn-1",itemId:"cmd-2",command:"npm run lint",cwd:harness.cwd,startedAtMs:Date.now()});
    await expect.poll(()=>second.answers()).toEqual([{decision:"acceptForSession"}]);
    codex.notify("serverRequest/resolved",{threadId:thread.id,requestId:second.id});
    // Network access asks each time: its card is the next the person sees, and the second command's never came.
    const network=codex.ask("item/commandExecution/requestApproval",{threadId:thread.id,turnId:"turn-1",itemId:"net-1",command:"npm install",cwd:harness.cwd,networkApprovalContext:{host:"registry.npmjs.org",protocol:"https"},startedAtMs:Date.now()});
    await expect(card(page)).toHaveCount(1);await expect(card(page)).toContainText("Network access needs approval");
    await expect(page.getByText("npm run lint")).toHaveCount(0);
    await shoot(page,"after-allow-session",()=>expect(card(page)).toContainText("registry.npmjs.org"));
    await card(page).getByRole("button",{name:"Deny",exact:true}).click();
    await expect.poll(()=>network.answers()).toEqual([{decision:"decline"}]);
    await expect(card(page)).toHaveCount(0);
    expect(second.answers()).toHaveLength(1);expect(first.answers()).toHaveLength(1);
  }finally{await harness.close()}
});

test("a Codex file-change approval's card names the files it adds, edits, moves and deletes",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,"Release notes");const {codex,thread,cwd}=harness;
  try{
    const file=(...parts)=>join(cwd,...parts);
    codex.notify("item/started",{threadId:thread.id,turnId:"turn-1",item:{type:"fileChange",id:"patch-1",status:"inProgress",changes:[
      {path:file("src","app.js"),kind:{type:"update",move_path:null},diff:"@@ -1 +1 @@\n-old\n+new\n"},
      {path:file("src","old-name.js"),kind:{type:"update",move_path:file("src","new-name.js")},diff:""},
      {path:file("NOTES.md"),kind:{type:"add"},diff:"+# Notes\n"},
      {path:file("legacy.txt"),kind:{type:"delete"},diff:""},
    ]}});
    const asked=codex.ask("item/fileChange/requestApproval",{threadId:thread.id,turnId:"turn-1",itemId:"patch-1",startedAtMs:Date.now()});
    await expect(card(page)).toHaveCount(1);await expect(card(page)).toContainText("File changes need approval");
    // One line a file, in Codex's order, each named from the thread's workspace.
    await expect.poll(()=>card(page).getByTestId("approval-files").innerText()).toBe([
      "Edit "+join("src","app.js"),"Move "+join("src","old-name.js")+" to "+join("src","new-name.js"),"Add NOTES.md","Delete legacy.txt",
    ].join("\n"));
    await expect(card(page)).not.toContainText("item/fileChange/requestApproval");
    await shoot(page,"file-change-files",()=>expect(card(page).getByTestId("approval-files")).toBeVisible());
    await card(page).getByRole("button",{name:"Allow once",exact:true}).click();
    await expect.poll(()=>asked.answers()).toEqual([{decision:"accept"}]);
    await expect(card(page)).toHaveCount(0);
  }finally{await harness.close()}
});
