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
// turn/start and ends it on turn/interrupt, and sends server requests as Codex does (ask), keeping every answer it gets back and
// when each request came (sentAt).
async function fakeCodex(thread){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set(),requests=[],answers=new Map(),goals=new Map(),turns=[];let nextId=7000;
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  const send=value=>{for(const ws of sockets)if(ws.readyState===1)ws.send(JSON.stringify(value))};
  const notify=(method,params)=>send({method,params});
  const running=()=>turns.some(turn=>turn.status==="inProgress");
  // A compaction runs as a turn of its own, with its contextCompaction item, until finishCompaction() ends it.
  const startCompaction=threadId=>{
    const turn={id:"codex-turn-"+(turns.length+1),threadId,status:"inProgress",input:[],compaction:true};turns.push(turn);
    notify("turn/started",{threadId,turn:{id:turn.id,status:"inProgress",items:[]}});
    notify("item/started",{threadId,turnId:turn.id,item:{type:"contextCompaction",id:"compaction-"+turn.id,status:"inProgress"}});
  };
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));
      if(message.id!=null&&!message.method){const id=String(message.id);answers.set(id,[...(answers.get(id)||[]),message.result]);return}
      if(message.id==null||!message.method)return;requests.push({...message,at:Date.now()});
      const params=message.params||{},reply=result=>{if(ws.readyState===1)ws.send(JSON.stringify({id:message.id,result}))},now=Math.floor(Date.now()/1000);
      if(message.method==="initialize")return reply({userAgent:"codex-approvals-goals"});
      if(message.method==="thread/list")return reply({data:[{...thread,status:{type:running()?"active":"idle"}}],nextCursor:null});
      if(message.method==="thread/resume"||message.method==="thread/read")return reply({thread:{...thread,status:{type:running()?"active":"idle"}},itemsBackwardsCursor:null,turnsBackwardsCursor:null});
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
      if(message.method==="thread/compact/start"){reply({});startCompaction(params.threadId);return}
      if(["thread/turns/list","thread/items/list","thread/attachment/list","thread/timeline/list","thread/queue/list","threadSection/list","thread/loaded/list"].includes(message.method))return reply({data:[],nextCursor:null});
      if(["skills/list","collaborationMode/list","experimentalFeature/list","permissionProfile/list","mcpServerStatus/list","app/list","hooks/list"].includes(message.method))return reply({data:[]});
      if(message.method==="thread/unsubscribe")return reply({status:"unsubscribed"});
      reply({});
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {
    port,requests,turns,goals,notify,startCompaction,
    sent:method=>requests.filter(item=>item.method===method).map(item=>item.params||{}),
    sentAt:method=>requests.filter(item=>item.method===method).map(item=>({at:item.at,params:item.params||{}})),
    ask(method,params){const id=nextId++;send({id,method,params});return {id,answers:()=>answers.get(String(id))||[]}},
    // A turn Codex runs that this window did not start (a goal's next turn), as the steps given ([method, item]) show it, until
    // turn/interrupt ends it.
    runTurn(threadId,steps){
      const turn={id:"codex-turn-"+(turns.length+1),threadId,status:"inProgress",input:[]};turns.push(turn);
      notify("turn/started",{threadId,turn:{id:turn.id,status:"inProgress",items:[]}});
      for(const [method,item] of steps)notify(method,{threadId,turnId:turn.id,item});
      return turn;
    },
    // The turn ends as Codex ends one: its reply, then turn/completed.
    completeTurn(turn,reply){
      const itemId="reply-"+turn.id;turn.status="completed";
      notify("item/started",{threadId:turn.threadId,turnId:turn.id,item:{type:"agentMessage",id:itemId,text:""}});
      notify("item/agentMessage/delta",{threadId:turn.threadId,turnId:turn.id,itemId,delta:reply});
      notify("item/completed",{threadId:turn.threadId,turnId:turn.id,item:{type:"agentMessage",id:itemId,text:reply}});
      notify("turn/completed",{threadId:turn.threadId,turn:{id:turn.id,status:"completed",items:[]}});
    },
    finishCompaction(){
      const turn=turns.find(item=>item.compaction&&item.status==="inProgress");if(!turn)return false;turn.status="completed";
      notify("item/completed",{threadId:turn.threadId,turnId:turn.id,item:{type:"contextCompaction",id:"compaction-"+turn.id,status:"completed"}});
      notify("thread/compacted",{threadId:turn.threadId,turnId:turn.id});
      notify("turn/completed",{threadId:turn.threadId,turn:{id:turn.id,status:"completed",items:[]}});return true;
    },
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
  await page.goto("/");await openThread(page,name);
  return {codex,gui,thread,cwd,
    async close(){await page.close().catch(()=>{});await gui.close();await codex.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250}).catch(()=>{})}};
}
// The person opens the thread from the sidebar, and it is ready for a message.
async function openThread(page,name){
  await page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)}).locator(".thread-main").click();
  await expect(page.locator(".workspace-header")).toContainText(name);
  await expect(page.getByTestId("composer")).toHaveAttribute("placeholder","Ask Trebell Code anything…",{timeout:15_000});
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
    // Its Allow session is named for what it allows: every later command of the thread's session.
    await expect(card(page).getByRole("button",{name:"Allow session",exact:true})).toHaveCount(0);
    await card(page).getByRole("button",{name:"Allow commands this session",exact:true}).click();
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
    // Allow session covers no more than this request here: the button keeps its plain name.
    await expect(card(page).getByRole("button",{name:"Allow session",exact:true})).toBeVisible();
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

test("a Codex file change of more than 200 files lists 200 on its card, says how many more, and its Allow session covers edits",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,"Rename everywhere");const {codex,thread,cwd}=harness;
  try{
    const changes=Array.from({length:203},(_,index)=>({path:join(cwd,"src","module-"+String(index).padStart(3,"0")+".js"),kind:{type:"update",move_path:null},diff:""}));
    codex.notify("item/started",{threadId:thread.id,turnId:"turn-1",item:{type:"fileChange",id:"codemod-1",status:"inProgress",changes}});
    const asked=codex.ask("item/fileChange/requestApproval",{threadId:thread.id,turnId:"turn-1",itemId:"codemod-1",startedAtMs:Date.now()});
    await expect(card(page)).toHaveCount(1);
    const files=card(page).getByTestId("approval-files");
    await expect.poll(async()=>(await files.innerText()).split("\n").length).toBe(201);
    const lines=(await files.innerText()).split("\n");
    expect(lines[0]).toBe("Edit "+join("src","module-000.js"));expect(lines[199]).toBe("Edit "+join("src","module-199.js"));expect(lines[200]).toBe("…and 3 more files");
    await files.evaluate(element=>{element.scrollTop=element.scrollHeight});
    await shoot(page,"file-change-more-files",()=>expect(files).toContainText("…and 3 more files"));
    await card(page).getByRole("button",{name:"Allow edits this session",exact:true}).click();
    await expect.poll(()=>asked.answers()).toEqual([{decision:"acceptForSession"}]);
    await expect(card(page)).toHaveCount(0);
  }finally{await harness.close()}
});

// The compaction is another window's /compact, as this window hears of it: Codex runs it as a turn of its own. (This window's own
// /compact keeps its composer's next send until the compaction has ended.)
test("/goal sent while Codex compacts the thread lets the compaction end, then starts the goal",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,"Release compaction");const {codex,thread}=harness;
  try{
    const composer=page.getByTestId("composer");
    codex.startCompaction(thread.id);
    await expect(page.getByText("Compacting context").first()).toBeVisible();await expect(page.getByRole("button",{name:"Stop",exact:true})).toBeVisible();
    await composer.click();await page.keyboard.type("/goal Ship the release notes",{delay:8});await page.keyboard.press("Enter");
    // The send waits, its draft held, while the compaction runs: nothing stops the compaction, and no goal is written yet. (A check
    // that something does not happen: a moment passes first.)
    await expect(composer).toHaveAttribute("placeholder",/^Sending/);
    await page.waitForTimeout(1500);
    expect(codex.sent("turn/interrupt")).toEqual([]);expect(codex.sent("thread/goal/set")).toEqual([]);
    await shoot(page,"goal-waits-for-compaction",()=>expect(page.getByText("Compacting context").first()).toBeVisible());
    expect(codex.finishCompaction()).toBe(true);
    // Once it has ended, the goal is set and its first turn starts; the compaction ended as it should.
    await expect.poll(()=>codex.turns.filter(turn=>!turn.compaction).length).toBe(1);
    expect(codex.turns.find(turn=>turn.compaction).status).toBe("completed");
    expect(codex.turns.find(turn=>!turn.compaction).input.filter(item=>item.type==="text").map(item=>item.text)).toEqual(["Start working toward this goal: Ship the release notes"]);
    await expect.poll(()=>codex.goals.get(thread.id)?.status).toBe("active");
    expect(codex.sent("turn/interrupt")).toEqual([]);
    await expect(composer).toHaveValue("");
    await expect(page.locator(".user-bubble").last()).toContainText("Ship the release notes");
  }finally{await harness.close()}
});

// A turn that Codex compacts as it works is no compaction of the thread's own: a goal command stops it as any other running turn.
test("/goal pause stops a goal's own turn that Codex compacts as it works, and the goal pauses",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,"Release goal compaction");const {codex,thread,cwd}=harness;
  try{
    const composer=page.getByTestId("composer"),stop=page.getByRole("button",{name:"Stop",exact:true}),now=Math.floor(Date.now()/1000);
    // The thread's goal is active, and Codex runs its next turn: a command has run, and now Codex compacts the context to go on.
    const goal={threadId:thread.id,objective:"Ship the release notes",status:"active",tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:now,updatedAt:now};
    codex.goals.set(thread.id,goal);codex.notify("thread/goal/updated",{threadId:thread.id,goal});
    const turn=codex.runTurn(thread.id,[
      ["item/started",{type:"commandExecution",id:"cmd-1",command:"npm test",cwd,status:"inProgress"}],
      ["item/completed",{type:"commandExecution",id:"cmd-1",command:"npm test",cwd,status:"completed",exitCode:0,aggregatedOutput:"ok"}],
      ["item/started",{type:"contextCompaction",id:"compaction-1",status:"inProgress"}],
    ]);
    await expect(page.getByText("Compacting context").first()).toBeVisible();await expect(stop).toBeVisible();
    await composer.click();await page.keyboard.type("/goal pause",{delay:8});await page.keyboard.press("Enter");
    // The goal's turn stops as Stop stops it, and the goal is paused, so Codex starts no further turn of it.
    await expect.poll(()=>codex.sent("turn/interrupt"),{timeout:10_000}).toEqual([{threadId:thread.id,turnId:turn.id}]);
    expect(turn.status).toBe("interrupted");
    await expect.poll(()=>codex.goals.get(thread.id)?.status).toBe("paused");
    await expect(stop).toHaveCount(0);await expect(composer).toHaveValue("");
    await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    const panel=page.getByTestId("goal-panel");
    await expect(panel.locator(".goal-status")).toHaveText("paused");
    await shoot(page,"goal-pause-stops-compacting-turn",()=>expect(panel.locator(".goal-status")).toHaveText("paused"));
  }finally{await harness.close()}
});

test("/goal sent while Codex compacts an ordinary turn as it works stops that turn at once, then starts the goal",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,"Release long turn");const {codex,thread}=harness;
  try{
    const composer=page.getByTestId("composer"),stop=page.getByRole("button",{name:"Stop",exact:true});
    await composer.click();await page.keyboard.type("Summarize what changed in this release.",{delay:8});await page.keyboard.press("Enter");
    await expect.poll(()=>codex.turns.length).toBe(1);await expect(stop).toBeVisible();
    // As Codex runs the turn: the person's message, then a compaction of the context on its way.
    const turn=codex.turns[0];
    codex.notify("item/started",{threadId:thread.id,turnId:turn.id,item:{type:"userMessage",id:"user-1",content:[{type:"text",text:"Summarize what changed in this release."}]}});
    codex.notify("item/started",{threadId:thread.id,turnId:turn.id,item:{type:"contextCompaction",id:"compaction-1",status:"inProgress"}});
    await expect(page.getByText("Compacting context").first()).toBeVisible();
    await composer.click();await page.keyboard.type("/goal Ship the release notes",{delay:8});await page.keyboard.press("Enter");
    // Stopped at once, not waited for, and the goal's first turn starts once it has ended.
    await expect.poll(()=>codex.sent("turn/interrupt"),{timeout:10_000}).toEqual([{threadId:thread.id,turnId:turn.id}]);
    await expect.poll(()=>codex.turns.length).toBe(2);
    expect(turn.status).toBe("interrupted");
    expect(codex.turns[1].input.filter(item=>item.type==="text").map(item=>item.text)).toEqual(["Start working toward this goal: Ship the release notes"]);
    await expect.poll(()=>codex.goals.get(thread.id)?.status).toBe("active");
    await expect(composer).toHaveValue("");await expect(stop).toBeVisible();
    await expect(page.locator(".user-bubble").last()).toContainText("Ship the release notes");
    await shoot(page,"goal-stops-compacting-turn",()=>expect(page.locator(".user-bubble").last()).toContainText("Ship the release notes"));
  }finally{await harness.close()}
});

test("/goal sent while a Codex turn runs stops that turn and starts the goal, whose first turn asks for the work",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,"Release goal");const {codex,thread}=harness;
  try{
    const composer=page.getByTestId("composer"),stop=page.getByRole("button",{name:"Stop",exact:true});
    await composer.click();await page.keyboard.type("Count from one to forty, one number per line.",{delay:8});await page.keyboard.press("Enter");
    await expect.poll(()=>codex.turns.length).toBe(1);await expect(stop).toBeVisible();
    // While it runs, a new goal: the running turn is stopped, then the goal is set and its first turn starts.
    await composer.click();await page.keyboard.type("/goal Ship the release notes",{delay:8});await page.keyboard.press("Enter");
    await expect.poll(()=>codex.sent("turn/interrupt")).toEqual([{threadId:thread.id,turnId:"codex-turn-1"}]);
    await expect.poll(()=>codex.turns.length).toBe(2);
    expect(codex.turns[0].status).toBe("interrupted");
    expect(codex.turns[1].input.filter(item=>item.type==="text").map(item=>item.text)).toEqual(["Start working toward this goal: Ship the release notes"]);
    await expect.poll(()=>codex.goals.get(thread.id)?.status).toBe("active");
    expect(codex.sent("thread/goal/set").map(params=>[params.objective||null,params.status||null])).toEqual([["Ship the release notes","paused"],[null,"active"]]);
    await expect(composer).toHaveValue("");await expect(stop).toBeVisible();
    // The person's message is the objective they typed: only Codex got the goal start before it.
    await expect(page.locator(".user-bubble").last()).toContainText("Ship the release notes");
    await expect(page.locator(".user-bubble").last()).not.toContainText("Start working toward this goal");
    await expect(page.getByTestId("composer-alert")).toHaveCount(0);
    // The Goal panel keeps the objective as written.
    await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    const panel=page.getByTestId("goal-panel");
    await expect(panel.getByLabel("Objective",{exact:true})).toHaveValue("Ship the release notes");await expect(panel.locator(".goal-status")).toHaveText("active");
    await shoot(page,"goal-during-turn",()=>expect(panel.locator(".goal-status")).toHaveText("active"));
  }finally{await harness.close()}
});

// Codex works toward an active goal with turns of its own, the next one as soon as one ends. A goal it starts no next turn for within
// 5 s of a completed one reads paused, not active with nothing running, and the Goal panel says why.
const PAUSED_WHY="Codex started no next turn for this goal after its last turn ended. Send /goal resume to continue.";
// The thread's goal is active, and Codex runs a turn of it and ends it, starting no next one: when it ended.
async function goalTurnEnds(page,codex,thread){
  const now=Math.floor(Date.now()/1000),goal={threadId:thread.id,objective:"Ship the release notes",status:"active",tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:now,updatedAt:now};
  codex.goals.set(thread.id,goal);codex.notify("thread/goal/updated",{threadId:thread.id,goal});
  const stop=page.getByRole("button",{name:"Stop",exact:true}),turn=codex.runTurn(thread.id,[]);await expect(stop).toBeVisible();
  const ended=Date.now();codex.completeTurn(turn,"Wrote the first section of the release notes.");
  await expect(page.getByText("Wrote the first section of the release notes.").first()).toBeVisible();await expect(stop).toHaveCount(0);
  return ended;
}
const pausedAfterWait=(codex,ended)=>codex.sentAt("thread/goal/set").map(({at,params})=>[params.status,at-ended>=5000]);

test("a Codex goal Codex starts no next turn for reads paused after 5 s, and the Goal panel says why, also after a reload, until it is resumed",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,"Release goal pause");const {codex,thread}=harness;
  try{
    const panel=page.getByTestId("goal-panel"),status=panel.locator(".goal-status"),note=panel.getByTestId("goal-pause-note");
    await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    const ended=await goalTurnEnds(page,codex,thread);await expect(status).toHaveText("active");
    await expect(status).toHaveText("paused",{timeout:15_000});
    expect(pausedAfterWait(codex,ended)).toEqual([["paused",true]]);
    await expect(note).toContainText("Goal paused");await expect(note).toContainText(PAUSED_WHY);
    await shoot(page,"goal-paused-no-next-turn",()=>expect(note).toContainText(PAUSED_WHY));
    // A window reloaded since reads the goal paused and says why too.
    await page.reload();await openThread(page,"Release goal pause");await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    await expect(status).toHaveText("paused");await expect(note).toContainText(PAUSED_WHY);
    // /goal resume, as the note says: the goal is active again, its next turn runs, and the note goes.
    await page.getByTestId("composer").click();await page.keyboard.type("/goal resume",{delay:8});await page.keyboard.press("Enter");
    await expect(status).toHaveText("active");await expect(note).toHaveCount(0);await expect(page.getByRole("button",{name:"Stop",exact:true})).toBeVisible();
    expect(codex.goals.get(thread.id).status).toBe("active");expect(codex.turns.map(turn=>turn.status)).toEqual(["completed","inProgress"]);
  }finally{await harness.close()}
});

// The pause goes on a window still there: the window that saw the turn end has gone, reloaded during the wait, and the reloaded one,
// which opened the thread, reads the goal paused once the wait is over.
test("a Codex goal reads paused once the 5 s wait for its next turn is over in a window reloaded during the wait",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,"Release goal reload");const {codex,thread}=harness;
  try{
    const panel=page.getByTestId("goal-panel"),status=panel.locator(".goal-status");
    const ended=await goalTurnEnds(page,codex,thread);
    await page.reload();await openThread(page,"Release goal reload");await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    await expect(status).toHaveText("paused",{timeout:15_000});
    expect(pausedAfterWait(codex,ended)).toEqual([["paused",true]]);
    await expect(panel.getByTestId("goal-pause-note")).toContainText(PAUSED_WHY);
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0);expect(codex.turns.filter(turn=>turn.status==="inProgress")).toEqual([]);
    await shoot(page,"goal-paused-after-reload",()=>expect(status).toHaveText("paused"));
  }finally{await harness.close()}
});

// No window is there as the wait ends: the window was closed as the reply came, and Trebell is opened again 7 s after the turn ended.
// The goal reads paused there.
test("a Codex goal reads paused in a window opened again after the one that saw its turn end was closed during the 5 s wait",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,"Release goal closed");const {codex,thread}=harness;
  try{
    const panel=page.getByTestId("goal-panel"),status=panel.locator(".goal-status");
    const ended=await goalTurnEnds(page,codex,thread);
    // The person is away until the wait is over: a time, not something to wait for on a page.
    await page.goto("about:blank");await page.waitForTimeout(Math.max(0,7000-(Date.now()-ended)));
    await page.goto("/");await openThread(page,"Release goal closed");await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    await expect(status).toHaveText("paused",{timeout:10_000});
    expect(pausedAfterWait(codex,ended)).toEqual([["paused",true]]);
    await expect(panel.getByTestId("goal-pause-note")).toContainText(PAUSED_WHY);
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0);expect(codex.turns.filter(turn=>turn.status==="inProgress")).toEqual([]);
  }finally{await harness.close()}
});
