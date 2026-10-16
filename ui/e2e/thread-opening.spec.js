import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

// The live tour (2026-10-11): after a server restart an OpenCode thread reopened from the sidebar took seconds to resume, and all
// that time the app went on showing what it showed before the click (the new-task screen, or the previous thread with its title and
// selected row), with only the composer saying "Opening thread…". These tests hold thread/resume in a fake harness the way a
// harness that has to start again does.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)}).catch(()=>{});
const frames=(page,count)=>page.evaluate(total=>new Promise(resolve=>{let left=total;const tick=()=>--left>0?requestAnimationFrame(tick):resolve();requestAnimationFrame(tick)}),count);
// A scroll position once the view stops moving: for a few frames after a scroll, rows coming into view take their real height
// (content-visibility estimates) and the browser moves the position to keep the rows being read in place.
const settledScrollTop=scroller=>scroller.evaluate(node=>new Promise(resolve=>{let last="",still=0,left=240;const tick=()=>{const now=node.scrollTop+":"+node.scrollHeight;still=now===last?still+1:0;last=now;if(still>=12||--left<=0)resolve(node.scrollTop);else requestAnimationFrame(tick)};requestAnimationFrame(tick)}));
const HARNESSES=[["opencode","OpenCode","sdk","opencode/fixture-fast"],["cursor","Cursor","acp","cursor-fixture"],["grok","Grok Build","acp","grok-fixture"]];
const CATALOGS=Object.fromEntries(HARNESSES.map(([id,name,,model])=>[id,{agentRuntime:id,ready:true,models:[model],defaultModel:model,metadata:{models:[{id:model,name:name+" Fixture",agent:id}]},error:null}]));
const FAILURE="OpenCode could not start this session: the harness exited before it answered (code 1).";
const PROJECT_NAME="Opening fixture";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// A saved thread with `turns` finished turns: "<name> question N." and "<name> answer N.", their rows named after the thread id.
function savedThread(id,name,{runtime="opencode",turns=1,minutesAgo=10,projectless=false}={}){
  const now=Date.now()/1000,model=CATALOGS[runtime].models[0];
  const list=Array.from({length:turns},(_,index)=>({id:`${id}-turn-${index+1}`,status:"completed",items:[
    {id:`${id}-ask-${index+1}`,type:"userMessage",content:[{type:"text",text:`${name} question ${index+1}.`}]},
    {id:`${id}-answer-${index+1}`,type:"agentMessage",text:`${name} answer ${index+1}. `+"Details of the saved reply. ".repeat(turns>1?6:1)},
  ]}));
  const thread={id,name,preview:`${name} question 1.`,cwd:process.cwd(),model,runtime,status:{type:"idle"},createdAt:now-3600,updatedAt:now-minutesAgo*60,turns:list};
  const meta={...(projectless?{projectless:true}:{}),environmentId:null,runtime,runtimeInstanceId:runtime+"-default",...(runtime==="opencode"?{}:{threadSnapshot:{...thread,turns:[],provider:runtime}})};
  return {thread,meta};
}

// One socket URL for all harnesses, as the agent relay serves them: each request is answered by the harness active when it arrives.
// hold(threadId) holds that thread's next thread/resume until the function it returns is called; fail[threadId] fails its resume,
// resumeDelay[threadId] answers it that many milliseconds late, and turnsCursor[threadId] has it page its history: the resume
// answers with a turns cursor, whose page (the thread's turns) answers once server.onTurnsList, when set, is done.
// holdList() holds the next thread/list the same way (a harness starting again lists late), and drop() closes the sockets, as a
// server restart does. The GUI server around it is faked with routes: the app starts in PROJECT_NAME (the repository folder), and
// holdSelect(), when set, holds the answer of a harness switch (the runtime changes at once); server.selectFail fails one.
// server.projectDelay slows the answer of a project opening, server.onProjectPost runs while one is asked for, and server.git makes
// the project a Git repository; extraProjects are more projects the GUI server knows. holdWorktree() holds the next worktree check
// (server.worktreeHeld says when one is held), emit() sends a notification and serverRequest() asks the app something, as the
// harness does; server.modes are the collaboration modes it lists.
async function startHarness(page,{runtime="opencode",saved=[],extraProjects=[]}={}){
  const server={runtime,requests:[],holds:new Map(),fail:{},resumeDelay:{},turnsCursor:{},onTurnsList:null,selects:0,selectHold:null,selectFail:null,listHold:null,turns:0,projectDelay:0,onProjectPost:null,worktreeHold:null,worktreeHeld:false,modes:[],nextRequestId:9000,git:false};
  const threads=saved.map(item=>item.thread),threadMeta=Object.fromEntries(saved.map(item=>[item.thread.id,item.meta]));
  const project={id:"opening-project",name:PROJECT_NAME,path:process.cwd(),environmentId:null,effectiveSettings:{}},projects=[project,...extraProjects];
  const http=createServer(),wss=new WebSocketServer({noServer:true});
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",async raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
    const params=message.params||{},active=server.runtime;server.requests.push({runtime:active,method:message.method,params});
    const send=value=>{if(ws.readyState===1)ws.send(JSON.stringify(value))};
    if(message.method==="thread/resume"){
      const held=params.excludeTurns!==false?server.holds.get(params.threadId):null;
      if(held){server.holds.delete(params.threadId);await held}
      if(params.excludeTurns!==false&&server.resumeDelay[params.threadId])await new Promise(resolve=>setTimeout(resolve,server.resumeDelay[params.threadId]));
      // Runs while the whole-history resume (what a harness without history pages answers after the first resume) is answered.
      if(params.excludeTurns===false&&server.onFullResume)await server.onFullResume(params.threadId);
      const thread=threads.find(item=>item.id===params.threadId);
      if(server.fail[params.threadId]||!thread)return send({id:message.id,error:{code:-32000,message:server.fail[params.threadId]||"Unknown fixture thread"}});
      return send({id:message.id,result:{thread:{...thread,turns:params.excludeTurns===false?thread.turns:[]},itemsBackwardsCursor:null,turnsBackwardsCursor:params.excludeTurns!==false&&server.turnsCursor[params.threadId]?"turns-cursor":null}});
    }
    if(message.method==="thread/turns/list"&&params.cursor==="turns-cursor"){
      if(server.onTurnsList)await server.onTurnsList();
      return send({id:message.id,result:{data:[...(threads.find(item=>item.id===params.threadId)?.turns||[])].reverse(),nextCursor:null}});
    }
    if(message.method==="turn/start"){
      const threadId=params.threadId,turnId=active+"-live-turn-"+(++server.turns);
      send({id:message.id,result:{turn:{id:turnId,status:"inProgress",items:[]}}});
      send({method:"turn/started",params:{threadId,turn:{id:turnId,status:"inProgress",startedAt:Date.now()/1000}}});
      send({method:"item/completed",params:{threadId,turnId,item:{id:"reply-"+turnId,type:"agentMessage",text:"Fixture reply in "+threadId}}});
      send({method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed",completedAt:Date.now()/1000}}});
      return;
    }
    if(message.method==="thread/list"&&server.listHold){const held=server.listHold;server.listHold=null;await held}
    let result={};
    if(message.method==="initialize")result={userAgent:"thread-opening-fixture"};
    else if(message.method==="thread/list")result={data:threads.filter(item=>item.runtime===active).map(item=>({...item,turns:[]})),nextCursor:null};
    else if(["thread/turns/list","thread/queue/list","thread/attachment/list","thread/timeline/list","thread/items/list","thread/searchOccurrences"].includes(message.method))result={data:[],nextCursor:null};
    else if(message.method==="collaborationMode/list")result={data:server.modes};
    else if(["threadSection/list","skills/list"].includes(message.method))result={data:[]};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
    send({id:message.id,result});
  }));
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  const wsUrl="ws://127.0.0.1:"+port+"/api/agent/ws";
  const settings=()=>({onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:server.runtime,agentRuntimeInstanceId:server.runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue",activeProjectId:project.id,keybindingRules:[{command:"threadPin",key:"Ctrl+Alt+P",when:"threadOpen && !modalOpen"},{command:"threadNext",key:"Ctrl+Alt+J",when:"threadOpen && !modalOpen"},{command:"threadStop",key:"Ctrl+Alt+S",when:"threadOpen && running && !modalOpen"}]});
  const bootstrap=()=>({mock:false,provider:"openai",providerReady:true,agentRuntime:server.runtime,agentRuntimeInstanceId:server.runtime+"-default",agentRuntimeReady:true,appServerReady:true,wsUrl,cwd:process.cwd(),platform:process.platform,version:"thread-opening-fixture",activeEnvironmentId:null,activeEnvironment:null});
  const snapshot=()=>{
    const statuses=HARNESSES.map(([kind,name])=>({id:kind+"-default",kind,name,available:true,installed:true,authenticated:true,version:"1.0.0-fixture"}));
    return {selectedRuntime:server.runtime,selectedInstanceId:server.runtime+"-default",definitions:HARNESSES.map(([id,name,protocol])=>({id,name,protocol,multipleInstances:false})),instances:statuses.map(({id,kind,name})=>({id,kind,displayName:name,enabled:true})),statuses};
  };
  await page.route(/\/api\/bootstrap$/,route=>json(route,bootstrap()));
  await page.route(/\/api\/state$/,route=>json(route,{settings:settings(),projects,threadMeta}));
  await page.route(/\/api\/settings$/,route=>json(route,settings()));
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,CATALOGS[server.runtime]));
  await page.route(/\/api\/agent-runtimes(?:\?.*)?$/,async route=>{
    if(route.request().method()==="GET")return json(route,snapshot());
    const body=route.request().postDataJSON()||{};server.selects++;
    if(server.selectFail)return json(route,{error:server.selectFail},500);
    server.runtime=body.runtime;
    if(server.selectHold)await server.selectHold;
    const current=snapshot();
    return json(route,{...current,selected:{runtime:server.runtime,instance:current.instances.find(item=>item.kind===server.runtime),status:current.statuses.find(item=>item.kind===server.runtime)},bootstrap:bootstrap(),catalog:CATALOGS[server.runtime]});
  });
  await page.route(/\/api\/providers$/,route=>json(route,{selected:"openai",providers:[{id:"openai",name:"OpenAI API",official:true,hasKey:true}],status:{id:"openai",hasKey:true},ready:true}));
  await page.route(/\/api\/projects$/,async route=>{
    if(route.request().method()==="GET")return json(route,{projects});
    if(server.onProjectPost)await server.onProjectPost();
    if(server.projectDelay)await new Promise(resolve=>setTimeout(resolve,server.projectDelay));
    const asked=String(route.request().postDataJSON()?.path||"");
    return json(route,{project:projects.find(item=>item.path===asked)||project});
  });
  await page.route(/\/api\/worktree\/ensure$/,async route=>{
    const held=server.worktreeHold;
    if(held){server.worktreeHold=null;server.worktreeHeld=true;await held}
    return json(route,{ok:true,path:process.cwd()});
  });
  await page.route(/\/api\/git\/info\?/,route=>json(route,server.git?{isGit:true,root:process.cwd(),branch:"main",branches:["main"],upstream:null,status:[],remotes:[],worktrees:[{path:process.cwd(),branch:"main"}]}:{isGit:false,root:process.cwd(),branch:null,status:[],remotes:[],worktrees:[]}));
  await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>{
    if(route.request().method()!=="POST")return json(route,threadMeta[new URL(route.request().url()).searchParams.get("threadId")]||{});
    const body=route.request().postDataJSON()||{},id=String(body.threadId||"");threadMeta[id]={...(threadMeta[id]||{}),...(body.patch||{})};return json(route,threadMeta[id]);
  });
  await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,{checkpoints:[]}));
  await page.route(/\/api\/general-workspace$/,route=>json(route,{path:process.cwd(),environmentId:null}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:264,rightPanelWidth:460,terminalHeight:330})));
  return {
    server,threadMeta,
    hold(threadId){let release=()=>{};server.holds.set(threadId,new Promise(resolve=>{release=resolve}));return release},
    holdSelect(){let release=()=>{};server.selectHold=new Promise(resolve=>{release=resolve});return ()=>{server.selectHold=null;release()}},
    holdList(){let release=()=>{};server.listHold=new Promise(resolve=>{release=resolve});return release},
    holdWorktree(){let release=()=>{};server.worktreeHeld=false;server.worktreeHold=new Promise(resolve=>{release=resolve});return release},
    emit(message){for(const client of wss.clients)if(client.readyState===1)client.send(JSON.stringify(message))},
    serverRequest(method,params){const id=++server.nextRequestId;for(const client of wss.clients)if(client.readyState===1)client.send(JSON.stringify({id,method,params}))},
    drop(){for(const client of wss.clients)try{client.terminate()}catch{}},
    resumes:threadId=>server.requests.filter(item=>item.method==="thread/resume"&&item.params.threadId===threadId&&item.params.excludeTurns!==false).length,
    sent:method=>server.requests.filter(item=>item.method===method).map(item=>item.params.threadId),
    async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
}

const ALPHA=savedThread("alpha-thread","Release checklist",{turns:24,minutesAgo:5});
const BETA=savedThread("beta-thread","Payment retries",{minutesAgo:15});
const GAMMA=savedThread("gamma-thread","Flaky import",{minutesAgo:25});
const DELTA=savedThread("delta-thread","Docs refresh",{minutesAgo:35,projectless:true});
const CURSOR=savedThread("cursor-thread","Cursor audit",{runtime:"cursor",minutesAgo:45,projectless:true});

const row=(page,saved)=>page.locator(`.thread-row[data-thread-id="${saved.thread.id}"]`);
const headerTitle=page=>page.locator(".workspace-header .thread-title-button strong");
const projectCrumb=page=>page.locator(".workspace-header .project-crumb:not(.sidebar-reopen) span");
const opening=page=>page.getByTestId("thread-opening");
const hero=page=>page.getByRole("heading",{name:"What do you want to build?"});
const answer=(page,saved,index=1)=>page.getByText(`${saved.thread.name} answer ${index}.`,{exact:false});
// A turn's items as the harness stores and sends them, and the activity steps on screen that name a command.
const userItem=(id,text)=>({id,type:"userMessage",content:[{type:"text",text}]});
const commandItem=(id,command,{status="completed"}={})=>({id,type:"commandExecution",command,cwd:process.cwd(),status,aggregatedOutput:status==="completed"?"ok\n":"",exitCode:status==="completed"?0:null});
const steps=(page,text)=>page.locator(".conversation-column .tool-event").filter({hasText:text});
async function start(page,harness){
  await page.goto("/");
  await expect(row(page,ALPHA)).toBeVisible({timeout:15_000});
  await expect(page.getByTestId("composer")).toBeEnabled({timeout:15_000});
}
async function openRow(page,saved){
  await row(page,saved).locator(".thread-main").click();
  await expect(answer(page,saved,saved.thread.turns.length)).toBeVisible({timeout:15_000});
  await expect(page.getByTestId("composer")).toBeEnabled();
}
// A row's menu action as a person picks it: over the row, its menu, then the action.
async function rowAction(page,saved,name){
  const target=row(page,saved);await target.hover();await target.locator(".thread-menu summary").click();
  await target.getByRole("button",{name,exact:true}).click();
}

// Samples every frame until stopFrames: the header title, the selected row, whether the opening state, the new-task hero and each
// thread's messages are on screen, and the composer's own controls (composer: the context in use, "unknown" without a value, then
// Compact and the mode picker when shown, "picker dimmed" when it is disabled), with the time since the first click after startFrames.
async function startFrames(page){
  await page.evaluate(()=>{
    const shown=node=>Boolean(node&&node.checkVisibility({visibilityProperty:true}));
    const run=window.__framesRun=(window.__framesRun||0)+1;window.__frames=[];window.__clickAt=null;
    document.addEventListener("click",()=>{if(window.__clickAt==null)window.__clickAt=performance.now()},{capture:true,once:true});
    const sample=()=>{
      const threads=[...new Set([...document.querySelectorAll(".conversation-column [data-message-id]")].filter(shown).map(node=>String(node.dataset.messageId).split("-")[0]))];
      const meter=document.querySelector(".composer-wrap .composer-context .context-meter"),picker=document.querySelector("[data-testid=collaboration-mode-picker]");
      const composer=[meter?meter.getAttribute("aria-valuenow")||"unknown":"none",[...document.querySelectorAll(".composer-context .context-compact-btn")].some(node=>node.textContent==="Compact")?"Compact":"",picker?(picker.disabled||getComputedStyle(picker).opacity!=="1"?"picker dimmed":"picker"):""].filter(Boolean).join(" ");
      window.__frames.push({at:performance.now(),title:document.querySelector(".workspace-header .thread-title-button strong")?.textContent||"",row:document.querySelector(".thread-row.active")?.dataset.threadId||null,opening:shown(document.querySelector("[data-testid=thread-opening]")),hero:shown(document.querySelector(".conversation-column .welcome")),threads,composer});
      if(window.__framesRun===run)requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}
const stopFrames=page=>page.evaluate(()=>{window.__framesRun++;const click=window.__clickAt??0;return window.__frames.filter(frame=>frame.at>=click).map(frame=>({...frame,t:Math.round(frame.at-click)}))});

// The opening state at every size and in both modes: whole, inside the conversation area and readable. Saves one screenshot each.
async function auditOpening(page,name,title){
  for(const mode of ["dark","light"]){
    await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
    for(const [width,height] of [[1280,800],[1600,980]]){
      await page.setViewportSize({width,height});await frames(page,3);
      await expect(opening(page)).toBeVisible();await expect(opening(page)).toContainText(title);await expect(opening(page)).toContainText("Opening thread…");
      const fit=await page.evaluate(()=>{
        const box=document.querySelector("[data-testid=thread-opening]").getBoundingClientRect(),main=document.querySelector(".main-frame").getBoundingClientRect(),header=document.querySelector(".workspace-header").getBoundingClientRect();
        const parts=[...document.querySelectorAll("[data-testid=thread-opening] *")].map(node=>({node,rect:node.getBoundingClientRect()})).filter(({rect})=>rect.width&&rect.height);
        return {outside:parts.filter(({rect})=>rect.left<main.left-1||rect.right>main.right+1||rect.top<header.bottom).map(({node})=>node.className||node.tagName),clipped:parts.filter(({node})=>node.scrollWidth>node.clientWidth+1&&getComputedStyle(node).textOverflow!=="ellipsis").map(({node})=>node.className||node.tagName),below:box.top<header.bottom-1};
      });
      expect(fit,`${name} ${mode} ${width}x${height}`).toEqual({outside:[],clipped:[],below:false});
      await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${width}x${height}.png`});
    }
  }
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await page.setViewportSize({width:1600,height:980});
}
// The conversation an open shows, in both modes with target in the middle of the view. Saves one screenshot each.
async function shootConversation(page,name,target){
  for(const mode of ["dark","light"]){
    await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await frames(page,3);
    await target.first().evaluate(node=>node.scrollIntoView({block:"center"}));await frames(page,4);
    await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-1600x980.png`});
  }
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
}

test("a thread that takes a while to open is the selected one at once and shows that it is opening, not the new-task screen",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});harness.server.git=true;
  const branch=page.locator(".workspace-header .branch-control");
  try{
    await start(page,harness);
    await expect(hero(page)).toBeVisible();await expect(headerTitle(page)).toHaveText("New Trebell task");await expect(branch).toHaveText("main");
    const release=harness.hold(BETA.thread.id);
    await startFrames(page);
    await row(page,BETA).locator(".thread-main").click();
    await expect.poll(()=>harness.resumes(BETA.thread.id)).toBe(1);
    // While thread/resume is held: the row and the header name the thread, the new-task screen is gone and the composer waits.
    await expect(row(page,BETA)).toHaveClass(/active/);
    await expect(headerTitle(page)).toHaveText("Payment retries");await expect(projectCrumb(page)).toHaveText(PROJECT_NAME);
    await expect(page.getByRole("button",{name:"New task",exact:true})).not.toHaveAttribute("aria-current","page");
    await expect(opening(page)).toBeVisible();await expect(opening(page)).toContainText("Payment retries");await expect(opening(page)).toContainText("Opening thread…");
    await expect(hero(page)).toBeHidden();
    // A thread of the same project keeps the project's branch in the header.
    await expect(branch).toHaveText("main");
    const composer=page.getByTestId("composer");await expect(composer).toBeDisabled();await expect(composer).toHaveAttribute("placeholder","Opening thread…");
    await page.waitForTimeout(400);
    const held=await stopFrames(page);
    // The row and the header switch at the click's next frames; the opening state follows once the open takes longer than a moment.
    const named=held.find(frame=>frame.title==="Payment retries"&&frame.row===BETA.thread.id),covered=held.find(frame=>frame.opening);
    expect(named?.t,"frames: "+JSON.stringify(held.slice(0,12))).toBeLessThan(100);
    expect(covered?.t).toBeGreaterThanOrEqual(150);expect(covered?.t).toBeLessThan(400);
    expect(held.filter(frame=>frame.t>=covered.t).every(frame=>frame.opening&&!frame.hero&&!frame.threads.length)).toBe(true);
    await auditOpening(page,"thread-opening-from-new-task","Payment retries");
    // Narrow: the sidebar is hidden and the opening state still names the thread in the middle of the conversation area.
    await page.setViewportSize({width:700,height:800});
    await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
    await expect(opening(page)).toBeVisible();await expect(opening(page)).toContainText("Payment retries");
    const narrow=await opening(page).boundingBox();expect(narrow.x).toBeGreaterThanOrEqual(0);expect(narrow.x+narrow.width).toBeLessThanOrEqual(701);
    await page.screenshot({animations:"disabled",path:auditDir+"thread-opening-narrow-dark-700x800.png"});
    await page.setViewportSize({width:1600,height:980});
    release();
    await expect(answer(page,BETA)).toBeVisible();await expect(opening(page)).toHaveCount(0);
    await expect(composer).toBeEnabled();await expect(composer).not.toHaveAttribute("placeholder","Opening thread…");
    await expect(row(page,BETA)).toHaveClass(/active/);await expect(headerTitle(page)).toHaveText("Payment retries");
  }finally{await harness.close()}
});

test("opened from another thread, a slow thread hides that thread at once and names itself",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});harness.server.git=true;
  const header=page.locator(".workspace-header");
  try{
    await start(page,harness);await openRow(page,ALPHA);
    await expect(header.locator(".branch-control")).toHaveText("main");await expect(header.locator(".review-control")).toBeVisible();
    const release=harness.hold(DELTA.thread.id);
    await row(page,DELTA).locator(".thread-main").click();
    await expect.poll(()=>harness.resumes(DELTA.thread.id)).toBe(1);
    await expect(row(page,DELTA)).toHaveClass(/active/);await expect(row(page,ALPHA)).not.toHaveClass(/active/);
    await expect(headerTitle(page)).toHaveText("Docs refresh");
    // A General chat thread: the crumb says so before it opens.
    await expect(projectCrumb(page)).toHaveText("No project");
    await expect(opening(page)).toBeVisible();await expect(opening(page)).toContainText("Docs refresh");
    await expect(answer(page,ALPHA,24)).toBeHidden();
    // The project's branch and the open thread's Review belong to the view before the click: a General chat thread opening shows
    // neither.
    await expect(header.locator(".branch-control")).toHaveCount(0);await expect(header.locator(".review-control")).toHaveCount(0);
    await auditOpening(page,"thread-opening-from-thread","Docs refresh");
    release();
    await expect(answer(page,DELTA)).toBeVisible();await expect(opening(page)).toHaveCount(0);await expect(answer(page,ALPHA,24)).toHaveCount(0);
    await expect(page.getByTestId("composer")).toBeEnabled();
  }finally{await harness.close()}
});

test("a thread that fails to open puts back exactly the view it replaced, the next message goes to the thread shown, and a failure after a later open says nothing",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  harness.server.fail[GAMMA.thread.id]=FAILURE;
  try{
    await start(page,harness);
    // From the new-task screen: it comes back as it was.
    let release=harness.hold(GAMMA.thread.id);
    await row(page,GAMMA).locator(".thread-main").click();
    await expect(opening(page)).toBeVisible();await expect(headerTitle(page)).toHaveText("Flaky import");
    release();
    await expect(page.locator(".sidebar-action-error")).toContainText(FAILURE);
    await expect(opening(page)).toHaveCount(0);await expect(hero(page)).toBeVisible();
    await expect(headerTitle(page)).toHaveText("New Trebell task");await expect(page.locator(".thread-row.active")).toHaveCount(0);
    await expect(page.getByTestId("composer")).toBeEnabled();
    // From a thread scrolled to its middle: the same row, title, messages and scroll position.
    await openRow(page,ALPHA);
    const scroller=page.locator(".conversation-scroll");
    await scroller.evaluate(node=>{node.scrollTop=Math.round((node.scrollHeight-node.clientHeight)/2)});
    const before=await settledScrollTop(scroller);expect(before).toBeGreaterThan(200);
    release=harness.hold(GAMMA.thread.id);
    await row(page,GAMMA).locator(".thread-main").click();
    await expect(opening(page)).toBeVisible();await expect(headerTitle(page)).toHaveText("Flaky import");await expect(row(page,ALPHA)).not.toHaveClass(/active/);
    release();
    await expect(page.locator(".sidebar-action-error")).toContainText(FAILURE);
    await expect(opening(page)).toHaveCount(0);
    await expect(row(page,ALPHA)).toHaveClass(/active/);await expect(row(page,GAMMA)).not.toHaveClass(/active/);
    await expect(headerTitle(page)).toHaveText("Release checklist");await expect(answer(page,ALPHA,12)).toBeVisible();
    expect(await scroller.evaluate(node=>node.scrollTop)).toBe(before);
    await page.screenshot({animations:"disabled",path:auditDir+"thread-opening-failed-restored-dark-1600x980.png"});
    const composer=page.getByTestId("composer");await expect(composer).toBeEnabled();
    await composer.fill("Follow-up after a failed open.");await page.getByTestId("send").click();
    await expect(page.getByText("Fixture reply in "+ALPHA.thread.id,{exact:true})).toBeVisible({timeout:15_000});
    expect(harness.server.requests.filter(item=>item.method==="turn/start").map(item=>item.params.threadId)).toEqual([ALPHA.thread.id]);
    // A thread that fails after a later open replaced it says nothing: the person has moved on to the thread shown.
    release=harness.hold(GAMMA.thread.id);
    await row(page,GAMMA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(GAMMA.thread.id)).toBe(3);
    await openRow(page,DELTA);
    release();await page.waitForTimeout(500);
    await expect(page.locator(".sidebar-action-error")).toHaveCount(0);await expect(page.getByTestId("app-action-error")).toHaveCount(0);
    await expect(headerTitle(page)).toHaveText("Docs refresh");await expect(answer(page,DELTA)).toBeVisible();await expect(row(page,DELTA)).toHaveClass(/active/);
  }finally{await harness.close()}
});

// A draft written before a click on a thread that does not open stays in the composer, which says beside it that the open failed
// and where a message sent now goes, so the draft never starts a new task or reaches another thread unseen. The thread shown whose
// reopen after a restart fails stays shown, and the transport connects again and reopens it by itself once the harness answers.
test("a thread that fails to open says so beside the draft, with where a send now goes, and a reopen that fails is tried again",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});harness.server.fail[GAMMA.thread.id]=FAILURE;
  const composer=page.getByTestId("composer"),note=page.getByTestId("composer-alert");
  try{
    await start(page,harness);
    await composer.fill("Ship the release notes.");
    let release=harness.hold(GAMMA.thread.id);
    await row(page,GAMMA).locator(".thread-main").click();
    await expect(opening(page)).toBeVisible();await expect(composer).toBeDisabled();await expect(page.getByTestId("send")).toBeDisabled();
    release();
    await expect(page.locator(".sidebar-action-error")).toContainText(FAILURE);
    await expect(note).toHaveText(`Could not open “Flaky import”: ${FAILURE} Sending now starts a new task instead.`);
    await expect(note).toHaveAttribute("role","status");await expect(page.locator(".composer-status")).toHaveClass(/error/);
    await expect(hero(page)).toBeVisible();await expect(composer).toBeEnabled();await expect(composer).toHaveValue("Ship the release notes.");
    expect([harness.sent("thread/start"),harness.sent("turn/start")]).toEqual([[],[]]);
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
      for(const [width,height] of [[1280,800],[900,800]]){
        await page.setViewportSize({width,height});await frames(page,3);
        const fit=await note.evaluate(node=>{const status=node.closest(".composer-status"),wrap=node.closest(".composer-wrap").getBoundingClientRect(),rect=node.getBoundingClientRect(),shell=document.querySelector(".workspace-shell");return {inside:rect.left>=wrap.left-1&&rect.right<=wrap.right+1,clipped:status.scrollWidth>status.clientWidth+1,sideways:shell.scrollWidth>shell.clientWidth+1}});
        expect(fit,`${mode} ${width}x${height}`).toEqual({inside:true,clipped:false,sideways:false});
        await page.screenshot({animations:"disabled",path:`${auditDir}thread-open-failed-note-${mode}-${width}x${height}.png`});
      }
    }
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await page.setViewportSize({width:1600,height:980});
    // Editing the draft keeps the note, which is about where the draft goes; a thread that opens ends it.
    await composer.press("End");await composer.pressSequentially(" Today.");await expect(note).toBeVisible();
    await openRow(page,BETA);await expect(note).toHaveCount(0);await expect(composer).toHaveValue("Ship the release notes. Today.");
    // From a thread, the note names the thread shown, which is where the draft goes; sending it there ends the note.
    release=harness.hold(GAMMA.thread.id);
    await row(page,GAMMA).locator(".thread-main").click();await expect(opening(page)).toBeVisible();
    release();
    await expect(note).toHaveText(`Could not open “Flaky import”: ${FAILURE} Sending now goes to “Payment retries”.`);
    await expect(headerTitle(page)).toHaveText("Payment retries");
    await page.getByTestId("send").click();
    await expect(page.getByText("Fixture reply in "+BETA.thread.id,{exact:true})).toBeVisible({timeout:15_000});
    await expect(note).toHaveCount(0);expect(harness.sent("turn/start")).toEqual([BETA.thread.id]);
    // A restart, after which the harness, still starting, refuses the first reopen of the thread shown and then answers as usual:
    // the thread stays shown, and the transport connects again and reopens it without a click, as it always has (Codex and Native
    // too). While it does, the composer says why the thread is opening again; once it is open, no note is left.
    harness.server.fail[BETA.thread.id]=FAILURE;
    const before=harness.resumes(BETA.thread.id);harness.drop();
    await expect.poll(()=>harness.resumes(BETA.thread.id),{timeout:15_000}).toBe(before+1);
    delete harness.server.fail[BETA.thread.id];const releaseReopen=harness.hold(BETA.thread.id);
    await expect.poll(()=>harness.resumes(BETA.thread.id),{timeout:15_000,message:"the thread shown opens again by itself"}).toBe(before+2);
    await expect(note).toHaveText(`Could not reopen “Payment retries”: ${FAILURE}`);
    await expect(page.getByTestId("app-action-error").filter({hasText:"Could not reopen thread"})).toHaveCount(0);
    await expect(headerTitle(page)).toHaveText("Payment retries");await expect(row(page,BETA)).toHaveClass(/active/);await expect(answer(page,BETA)).toBeVisible();
    const shoot=async name=>{
      for(const mode of ["dark","light"]){
        await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
        for(const [width,height] of [[1280,800],[900,800]]){await page.setViewportSize({width,height});await frames(page,3);await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${width}x${height}.png`})}
      }
      await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await page.setViewportSize({width:1600,height:980});
    };
    await shoot("thread-reopen-retrying");
    releaseReopen();
    await expect(note).toHaveCount(0,{timeout:15_000});await expect(composer).toBeEnabled();
    await expect(headerTitle(page)).toHaveText("Payment retries");await expect(row(page,BETA)).toHaveClass(/active/);await expect(answer(page,BETA)).toBeVisible();
    await expect(composer).toHaveValue("");expect(harness.resumes(BETA.thread.id)).toBe(before+2);
    await shoot("thread-reopened-after-failure");
  }finally{await harness.close()}
});

test("of two threads opening at once the last one asked for wins, whichever answers first, and a new task replaces both",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  try{
    await start(page,harness);await openRow(page,ALPHA);
    // The second answers first: it shows, and the first one's late answer never replaces it.
    let releaseBeta=harness.hold(BETA.thread.id),releaseDelta=harness.hold(DELTA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(BETA.thread.id)).toBe(1);
    await row(page,DELTA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(DELTA.thread.id)).toBe(1);
    await expect(headerTitle(page)).toHaveText("Docs refresh");await expect(row(page,DELTA)).toHaveClass(/active/);await expect(row(page,BETA)).not.toHaveClass(/active/);
    releaseDelta();
    await expect(answer(page,DELTA)).toBeVisible();await expect(opening(page)).toHaveCount(0);
    releaseBeta();
    await expect.poll(()=>harness.server.requests.filter(item=>item.method==="thread/resume"&&item.params.threadId===BETA.thread.id).length).toBe(2);
    await page.waitForTimeout(500);
    await expect(answer(page,DELTA)).toBeVisible();await expect(answer(page,BETA)).toHaveCount(0);
    await expect(headerTitle(page)).toHaveText("Docs refresh");await expect(row(page,DELTA)).toHaveClass(/active/);await expect(row(page,BETA)).not.toHaveClass(/active/);
    await expect(page.getByTestId("composer")).toBeEnabled();
    // The first answers first: it never shows, and the view keeps waiting for the second.
    releaseBeta=harness.hold(BETA.thread.id);const releaseAlpha=harness.hold(ALPHA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(BETA.thread.id)).toBe(2);
    await row(page,ALPHA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(ALPHA.thread.id)).toBe(2);
    releaseBeta();
    await expect.poll(()=>harness.server.requests.filter(item=>item.method==="thread/resume"&&item.params.threadId===BETA.thread.id).length).toBe(4);
    await page.waitForTimeout(500);
    await expect(answer(page,BETA)).toHaveCount(0);await expect(opening(page)).toBeVisible();await expect(opening(page)).toContainText("Release checklist");
    await expect(headerTitle(page)).toHaveText("Release checklist");await expect(page.getByTestId("composer")).toBeDisabled();
    releaseAlpha();
    await expect(answer(page,ALPHA,24)).toBeVisible();await expect(opening(page)).toHaveCount(0);await expect(answer(page,BETA)).toHaveCount(0);
    // A new task asked for while a thread opens replaces it, and the thread's late answer does not come back over it.
    releaseBeta=harness.hold(BETA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(BETA.thread.id)).toBe(3);
    await page.getByRole("button",{name:"New thread",exact:true}).click();
    await expect(hero(page)).toBeVisible();await expect(opening(page)).toHaveCount(0);await expect(headerTitle(page)).toHaveText("New Trebell task");
    await expect(page.locator(".thread-row.active")).toHaveCount(0);await expect(page.getByTestId("composer")).toBeEnabled();
    releaseBeta();
    await expect.poll(()=>harness.server.requests.filter(item=>item.method==="thread/resume"&&item.params.threadId===BETA.thread.id).length).toBe(6);
    await page.waitForTimeout(500);
    await expect(hero(page)).toBeVisible();await expect(answer(page,BETA)).toHaveCount(0);await expect(page.locator(".thread-row.active")).toHaveCount(0);
  }finally{await harness.close()}
});

// A new task is asked for to be typed: from an open thread, from one still opening and in a narrow window, Ctrl+N, the sidebar's
// New thread and New task and the palette's New thread and New general chat each leave the keyboard in its composer, so what the
// person types next lands there instead of nowhere or on the button they clicked.
test("a new task asked for with Ctrl+N, the sidebar's New thread or New task, or the palette has the keyboard in its composer",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  const composer=page.getByTestId("composer"),palette=page.getByTestId("command-palette");
  const newThread=page.getByRole("button",{name:"New thread",exact:true}),newTask=page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"New task",exact:true});
  // The new task shows with the keyboard in its composer, and the text typed next is its draft.
  const typeInNewTask=async text=>{
    await expect(headerTitle(page)).toHaveText("New Trebell task");await expect(page.locator(".thread-row.active")).toHaveCount(0);
    await expect(composer).toBeFocused();
    await page.keyboard.type(text,{delay:15});await expect(composer).toHaveValue(text);
  };
  try{
    await start(page,harness);
    // Ctrl+N from an open thread, after a click in its conversation took the keyboard off the controls.
    await openRow(page,ALPHA);
    await page.locator(".conversation-column").click({position:{x:5,y:5}});await expect(composer).not.toBeFocused();
    await page.keyboard.press("Control+n");
    await typeInNewTask("Plan the export fix");
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
      for(const [width,height] of [[1280,800],[900,800]]){await page.setViewportSize({width,height});await frames(page,3);await expect(composer).toBeFocused();await page.screenshot({animations:"disabled",path:`${auditDir}new-task-keyboard-in-composer-${mode}-${width}x${height}.png`})}
    }
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await page.setViewportSize({width:1600,height:980});
    // The sidebar's New thread, then its New task, each clicked from another open thread.
    for(const [saved,button] of [[BETA,newThread],[GAMMA,newTask]]){
      await openRow(page,saved);await button.click();
      await typeInNewTask("Write the "+saved.thread.name.toLowerCase()+" notes");
    }
    // The palette's New thread and New general chat, with the palette opened from the sidebar's search button.
    for(const [saved,command] of [[DELTA,"New thread"],[ALPHA,"New general chat"]]){
      await openRow(page,saved);
      await page.getByRole("button",{name:"Search or jump to",exact:true}).click();await expect(palette.locator(".command-palette-item").first()).toBeVisible();
      await page.keyboard.type(">"+command.toLowerCase(),{delay:15});
      await expect(palette.locator(".command-palette-item.selected strong")).toHaveText(command);
      await page.keyboard.press("Enter");await expect(palette).toHaveCount(0);
      await typeInNewTask("Sketch the "+command.toLowerCase()+" plan");
    }
    // Ctrl+N while a thread opened from another one is still opening, its composer held: the new task replaces the open and takes
    // the keyboard.
    await openRow(page,GAMMA);
    const release=harness.hold(BETA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await expect(composer).toBeDisabled();
    await page.keyboard.press("Control+n");
    await typeInNewTask("Check the release notes");
    release();
    // In a window too narrow for the sidebar beside the conversation: New thread in the sidebar opened from the header.
    await openRow(page,ALPHA);
    await page.setViewportSize({width:700,height:800});await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
    await page.getByRole("button",{name:"Open sidebar",exact:true}).first().click();await newThread.click();
    await typeInNewTask("Fix the narrow layout");
    await page.screenshot({animations:"disabled",path:auditDir+"new-task-keyboard-in-composer-narrow-dark-700x800.png"});
  }finally{await harness.close()}
});

test("while a thread opens, the thread shortcuts follow the thread the header names",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  try{
    await start(page,harness);await openRow(page,ALPHA);
    // Release checklist has a turn running, which its Stop shortcut would stop.
    harness.emit({method:"turn/started",params:{threadId:ALPHA.thread.id,turn:{id:"alpha-live",status:"inProgress",startedAt:Date.now()/1000}}});
    await expect(page.locator(".workspace-header .stop-control")).toBeVisible();
    const moves=()=>harness.server.requests.filter(item=>item.method==="thread/section/move");
    const releaseBeta=harness.hold(BETA.thread.id),releaseGamma=harness.hold(GAMMA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(BETA.thread.id)).toBe(1);
    await expect(headerTitle(page)).toHaveText("Payment retries");
    // Pin and Stop wait for the thread being opened instead of acting on the one the view is leaving.
    await page.keyboard.press("Control+Alt+P");await page.keyboard.press("Control+Alt+S");await page.waitForTimeout(300);
    expect(moves()).toHaveLength(0);expect(harness.sent("turn/interrupt")).toEqual([]);
    // Next steps from the selected thread, not from the one still underneath.
    await page.keyboard.press("Control+Alt+J");await expect.poll(()=>harness.resumes(GAMMA.thread.id)).toBe(1);
    expect(harness.resumes(BETA.thread.id)).toBe(1);
    await expect(headerTitle(page)).toHaveText("Flaky import");await expect(row(page,GAMMA)).toHaveClass(/active/);
    releaseBeta();releaseGamma();
    await expect(answer(page,GAMMA)).toBeVisible();await expect(page.getByTestId("composer")).toBeEnabled();await expect(answer(page,BETA)).toHaveCount(0);
    await page.keyboard.press("Control+Alt+P");await expect.poll(()=>moves().length).toBe(1);
    expect(moves()[0].params.threadId).toBe(GAMMA.thread.id);
  }finally{await harness.close()}
});

test("the thread already open shows no opening state, and a quick open never flashes one, the new-task screen, an empty view or an empty composer",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  try{
    await start(page,harness);
    // Quick opens: from the new-task screen, then from a thread to a project thread and to a General chat thread. The project opens
    // in a few frames, as a real server's does: that used to show the empty new-task screen between two project threads.
    harness.server.projectDelay=40;
    // Each thread has its own context in use. A quick open shows the context of the view before the click until the thread shows,
    // and Compact all along from one thread to another, instead of blanking them for a few frames.
    const usage=input=>({total:{totalTokens:input*2,inputTokens:input,outputTokens:input},last:{totalTokens:input,inputTokens:input,outputTokens:0},modelContextWindow:200000});
    for(const [saved,input] of [[ALPHA,100000],[BETA,60000],[DELTA,20000]])harness.emit({method:"thread/tokenUsage/updated",params:{threadId:saved.thread.id,tokenUsage:usage(input)}});
    const context=saved=>saved?{[ALPHA.thread.id]:"50",[BETA.thread.id]:"30",[DELTA.thread.id]:"10"}[saved.thread.id]+" Compact":"unknown";
    const quick=[];
    for(const [from,saved] of [[null,ALPHA],[ALPHA,BETA],[BETA,DELTA],[DELTA,ALPHA]]){
      await startFrames(page);
      await row(page,saved).locator(".thread-main").click();
      await expect(answer(page,saved,saved.thread.turns.length)).toBeVisible();await expect(page.getByTestId("composer")).toBeEnabled();
      await frames(page,4);
      const seen=await stopFrames(page),shownAt=seen.find(frame=>frame.threads.includes(saved.thread.id.split("-")[0]))?.t;
      quick.push({from:from?.thread.id||"new task",to:saved.thread.id,shownAt});
      expect(seen.filter(frame=>frame.opening),"no opening state in a quick open: "+JSON.stringify(seen)).toEqual([]);
      // Every frame shows the view before the click or the thread: nothing in between.
      const before=from?[from.thread.id.split("-")[0]]:[],after=[saved.thread.id.split("-")[0]];
      const between=seen.filter(frame=>!(from?JSON.stringify(frame.threads)===JSON.stringify(before):frame.hero)&&JSON.stringify(frame.threads)!==JSON.stringify(after));
      expect(between,"frames between the two views: "+JSON.stringify(seen)).toEqual([]);
      const steps=seen.map(frame=>frame.composer).filter((value,index,all)=>value!==all[index-1]);
      expect(steps.slice(steps[0]===context(from)?1:0),"the composer's frames: "+JSON.stringify(seen)).toEqual([context(saved)]);
    }
    console.log("quick opens (ms from the click to the thread's first frame):",JSON.stringify(quick));
    // The thread already open, clicked again while its resume takes long: nothing about the view changes.
    const release=harness.hold(ALPHA.thread.id);
    await row(page,ALPHA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(ALPHA.thread.id)).toBe(3);
    await page.waitForTimeout(500);
    await expect(opening(page)).toHaveCount(0);await expect(answer(page,ALPHA,24)).toBeVisible();await expect(headerTitle(page)).toHaveText("Release checklist");await expect(row(page,ALPHA)).toHaveClass(/active/);
    release();
    await expect(page.getByTestId("composer")).toBeEnabled();await expect(answer(page,ALPHA,24)).toBeVisible();
  }finally{await harness.close()}
});

test("a thread of another harness shows its opening state through the harness switch until it opens",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA,CURSOR]});
  try{
    await start(page,harness);await openRow(page,ALPHA);
    await expect(row(page,CURSOR).locator(".thread-runtime-chip")).toHaveText("Cursor");
    const releaseSelect=harness.holdSelect(),releaseResume=harness.hold(CURSOR.thread.id);
    await row(page,CURSOR).locator(".thread-main").click();
    await expect.poll(()=>harness.server.selects).toBe(1);
    await expect(row(page,CURSOR)).toHaveClass(/active/);await expect(headerTitle(page)).toHaveText("Cursor audit");
    await expect(opening(page)).toBeVisible();await expect(opening(page)).toContainText("Cursor audit");await expect(answer(page,ALPHA,24)).toBeHidden();
    await page.screenshot({animations:"disabled",path:auditDir+"thread-opening-harness-switch-dark-1600x980.png"});
    // The switch lands (Cursor runs, its transport reconnects): the thread is still opening, and still shown as opening.
    releaseSelect();
    await expect(page.locator(".sidebar-provider strong")).toContainText("Cursor",{timeout:15_000});
    await expect.poll(()=>harness.resumes(CURSOR.thread.id),{timeout:15_000}).toBe(1);
    await page.waitForTimeout(400);
    await expect(opening(page)).toBeVisible();await expect(headerTitle(page)).toHaveText("Cursor audit");await expect(row(page,CURSOR)).toHaveClass(/active/);
    await expect(hero(page)).toBeHidden();
    releaseResume();
    await expect(answer(page,CURSOR)).toBeVisible({timeout:15_000});await expect(opening(page)).toHaveCount(0);
    await expect(page.getByTestId("composer")).toBeEnabled();
  }finally{await harness.close()}
});

test("a thread opened from History, the command palette or a search result is named and shown as opening at once",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  try{
    await start(page,harness);
    // History: the page gives way to the thread's opening state, and comes back if it cannot open.
    await page.getByRole("button",{name:"History",exact:true}).click();
    const historyRow=page.locator(".history-thread-row").filter({hasText:"Payment retries"});await expect(historyRow).toBeVisible({timeout:15_000});
    let release=harness.hold(BETA.thread.id);
    await historyRow.click();
    await expect(row(page,BETA)).toHaveClass(/active/);
    await expect(opening(page)).toBeVisible();await expect(headerTitle(page)).toHaveText("Payment retries");
    await page.screenshot({animations:"disabled",path:auditDir+"thread-opening-from-history-dark-1600x980.png"});
    release();
    await expect(answer(page,BETA)).toBeVisible();await expect(opening(page)).toHaveCount(0);
    harness.server.fail[GAMMA.thread.id]=FAILURE;
    await page.getByRole("button",{name:"History",exact:true}).click();
    release=harness.hold(GAMMA.thread.id);
    await page.locator(".history-thread-row").filter({hasText:"Flaky import"}).click();
    await expect(opening(page)).toBeVisible();await expect(headerTitle(page)).toHaveText("Flaky import");
    release();
    await expect(page.getByTestId("app-action-error")).toContainText(FAILURE);
    await expect(page.getByRole("heading",{name:"Thread history"})).toBeVisible();await expect(row(page,BETA)).toHaveClass(/active/);
    // The command palette: the row and the header switch behind it while it waits for the thread.
    release=harness.hold(DELTA.thread.id);
    await page.getByRole("button",{name:"Threads",exact:true}).click();await expect(answer(page,BETA)).toBeVisible();
    await page.keyboard.press("Control+k");
    const palette=page.getByRole("dialog");await expect(palette).toBeVisible();
    await page.keyboard.type("Docs refresh");await expect(palette.getByText("Docs refresh",{exact:true}).first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(()=>harness.resumes(DELTA.thread.id)).toBe(1);
    await expect(row(page,DELTA)).toHaveClass(/active/);await expect(headerTitle(page)).toHaveText("Docs refresh");
    await expect(opening(page)).toBeVisible();
    release();
    await expect(answer(page,DELTA)).toBeVisible();await expect(opening(page)).toHaveCount(0);
    // A search result: the row the search shows is selected at once, and the thread shows as opening.
    release=harness.hold(ALPHA.thread.id);
    await page.getByRole("textbox",{name:"Search threads"}).fill("Release");
    const result=row(page,ALPHA);await expect(result).toBeVisible();await expect(row(page,BETA)).toHaveCount(0);
    await result.locator(".thread-main").click();
    await expect.poll(()=>harness.resumes(ALPHA.thread.id)).toBe(1);
    await expect(result).toHaveClass(/active/);await expect(headerTitle(page)).toHaveText("Release checklist");
    await expect(opening(page)).toBeVisible();await expect(answer(page,DELTA)).toBeHidden();
    release();
    await expect(answer(page,ALPHA,24)).toBeVisible();await expect(opening(page)).toHaveCount(0);
  }finally{await harness.close()}
});

test("a thread clicked while a restarted harness lists its threads again opens, and the thread before it reopens there only if that open fails",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});harness.server.fail[GAMMA.thread.id]=FAILURE;
  const lists=()=>harness.sent("thread/list").length;
  // A server restart: the socket drops, the app connects again and lists the threads, which the restarted harness answers late.
  async function restart(){const listed=lists(),release=harness.holdList();harness.drop();await expect.poll(lists,{timeout:15_000}).toBe(listed+1);return release}
  try{
    await start(page,harness);await openRow(page,ALPHA);
    // Connected again, the person opens another thread, which takes a while, and the list comes in meanwhile: the thread open before
    // the restart, which the reconnect resumes, is not reopened over the one asked for.
    let releaseList=await restart(),releaseOpen=harness.hold(BETA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(BETA.thread.id)).toBe(1);
    releaseList();await page.waitForTimeout(500);
    expect(harness.resumes(ALPHA.thread.id)).toBe(1);await expect(opening(page)).toBeVisible();await expect(headerTitle(page)).toHaveText("Payment retries");
    releaseOpen();
    await expect(answer(page,BETA)).toBeVisible();await expect(page.getByTestId("composer")).toBeEnabled();
    await expect(row(page,BETA)).toHaveClass(/active/);await expect(headerTitle(page)).toHaveText("Payment retries");await expect(answer(page,ALPHA,24)).toHaveCount(0);
    // It resumed on the new connection itself, so the reconnect does not resume it again.
    await page.waitForTimeout(400);expect([harness.resumes(ALPHA.thread.id),harness.resumes(BETA.thread.id)]).toEqual([1,1]);
    // Again with a thread that cannot open: the view goes back to Payment retries, which then resumes on the new connection, and the
    // next message goes to it.
    releaseList=await restart();releaseOpen=harness.hold(GAMMA.thread.id);
    await row(page,GAMMA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(GAMMA.thread.id)).toBe(1);
    releaseList();await page.waitForTimeout(500);expect(harness.resumes(BETA.thread.id)).toBe(1);
    releaseOpen();
    await expect(page.locator(".sidebar-action-error")).toContainText(FAILURE);
    await expect.poll(()=>harness.resumes(BETA.thread.id)).toBe(2);
    await expect(row(page,BETA)).toHaveClass(/active/);await expect(headerTitle(page)).toHaveText("Payment retries");await expect(answer(page,BETA)).toBeVisible();
    const composer=page.getByTestId("composer");await expect(composer).toBeEnabled();
    await composer.fill("Follow-up after the restart.");await page.getByTestId("send").click();
    await expect(page.getByText("Fixture reply in "+BETA.thread.id,{exact:true})).toBeVisible({timeout:15_000});
    expect(harness.sent("turn/start")).toEqual([BETA.thread.id]);
  }finally{await harness.close()}
});

test("a page asked for while a thread opens shows at once, and the thread opens behind it",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  const heading=name=>page.getByRole("heading",{name,exact:true}),history=page.getByRole("button",{name:"History",exact:true});
  try{
    await start(page,harness);await openRow(page,ALPHA);
    const release=harness.hold(BETA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await expect(opening(page)).toBeVisible();
    // History from the sidebar, then Settings and Projects from their shortcuts: each shows when asked for, as the selected page.
    await history.click();
    await expect(heading("Thread history")).toBeVisible();await expect(history).toHaveClass(/active/);await expect(opening(page)).toHaveCount(0);
    await page.keyboard.press("Control+Comma");await expect(heading("Settings")).toBeVisible();
    await page.keyboard.press("Control+Shift+P");await expect(heading("Projects")).toBeVisible();
    await page.screenshot({animations:"disabled",path:auditDir+"thread-opening-page-asked-for-dark-1600x980.png"});
    await expect(row(page,BETA)).toHaveClass(/active/);
    // The thread lands behind the page asked for last, which stays, and is the open thread back in the threads.
    release();await expect.poll(()=>harness.sent("thread/goal/get").filter(id=>id===BETA.thread.id).length).toBe(1);await page.waitForTimeout(500);
    await expect(heading("Projects")).toBeVisible();await expect(page.locator(".chat-workspace")).toHaveCount(0);
    await page.getByRole("button",{name:"Threads",exact:true}).click();
    await expect(answer(page,BETA)).toBeVisible();await expect(opening(page)).toHaveCount(0);await expect(headerTitle(page)).toHaveText("Payment retries");
    await expect(page.getByTestId("composer")).toBeEnabled();
  }finally{await harness.close()}
});

// A thread opened from History covers History with its opening state. History asked for again is a page asked for after the click
// too: its button did nothing (History not even selected), and after another page History showed the opening state again, until the
// thread took the view from it. Clicked or pressed with the keyboard, History shows, and the thread opens behind it.
test("History asked for while a thread opened from it opens shows History, and the thread opens behind it",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  const heading=name=>page.getByRole("heading",{name,exact:true}),history=page.getByRole("button",{name:"History",exact:true});
  const historyRow=name=>page.locator(".history-thread-row").filter({hasText:name});
  try{
    await start(page,harness);
    await history.click();await expect(historyRow("Payment retries")).toBeVisible({timeout:15_000});
    const release=harness.hold(BETA.thread.id);
    await historyRow("Payment retries").click();
    await expect(opening(page)).toBeVisible();await expect(heading("Thread history")).toHaveCount(0);
    await history.click();
    await expect(heading("Thread history")).toBeVisible();await expect(history).toHaveClass(/active/);await expect(opening(page)).toHaveCount(0);
    await expect(row(page,BETA)).toHaveClass(/active/);
    for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);await page.screenshot({animations:"disabled",path:`${auditDir}thread-opening-history-asked-again-${mode}-1600x980.png`})}
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    // Usage, then History from the keyboard: each shows when asked for.
    await page.getByRole("button",{name:"Usage",exact:true}).click();await expect(heading("Usage")).toBeVisible();
    await history.focus();await page.keyboard.press("Enter");
    await expect(heading("Thread history")).toBeVisible();await expect(history).toHaveClass(/active/);await expect(opening(page)).toHaveCount(0);
    // The thread lands behind History, which stays.
    release();await expect.poll(()=>harness.sent("thread/goal/get").filter(id=>id===BETA.thread.id).length).toBe(1);await page.waitForTimeout(500);
    await expect(heading("Thread history")).toBeVisible();await expect(page.locator(".chat-workspace")).toHaveCount(0);await expect(row(page,BETA)).toHaveClass(/active/);
    // A row picked in History now opens its thread in the chat, as before.
    await historyRow("Flaky import").click();
    await expect(answer(page,GAMMA)).toBeVisible();await expect(headerTitle(page)).toHaveText("Flaky import");await expect(heading("Thread history")).toHaveCount(0);
  }finally{await harness.close()}
});

test("archiving the thread left while another opens keeps that open, and archiving a thread as it opens ends its open for good",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  try{
    await start(page,harness);await openRow(page,ALPHA);
    // The thread just left, no longer the selected row: Payment retries goes on opening, and opens.
    let release=harness.hold(BETA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await expect(opening(page)).toBeVisible();
    await rowAction(page,ALPHA,"Archive");
    await expect.poll(()=>harness.sent("thread/archive")).toEqual([ALPHA.thread.id]);await expect(row(page,ALPHA)).toHaveCount(0);
    await expect(opening(page)).toBeVisible();await expect(headerTitle(page)).toHaveText("Payment retries");
    release();
    await expect(answer(page,BETA)).toBeVisible();await expect(row(page,BETA)).toHaveClass(/active/);await expect(page.getByTestId("composer")).toBeEnabled();
    // A thread that then fails to open comes back to a new task, not to the archived thread it was opened from.
    harness.server.fail[GAMMA.thread.id]=FAILURE;release=harness.hold(GAMMA.thread.id);
    await row(page,GAMMA).locator(".thread-main").click();await expect(opening(page)).toBeVisible();
    await rowAction(page,BETA,"Archive");await expect.poll(()=>harness.sent("thread/archive")).toEqual([ALPHA.thread.id,BETA.thread.id]);
    await expect(opening(page)).toBeVisible();
    release();
    await expect(page.locator(".sidebar-action-error")).toContainText(FAILURE);
    await expect(hero(page)).toBeVisible();await expect(headerTitle(page)).toHaveText("New Trebell task");
    await expect(page.locator(".thread-row.active")).toHaveCount(0);await expect(answer(page,BETA)).toHaveCount(0);
    // The thread opening is the selected row: archiving it ends its open, and its late answer neither shows it nor un-archives it.
    release=harness.hold(DELTA.thread.id);
    await row(page,DELTA).locator(".thread-main").click();await expect(opening(page)).toBeVisible();
    await rowAction(page,DELTA,"Archive");await expect.poll(()=>harness.sent("thread/archive")).toEqual([ALPHA.thread.id,BETA.thread.id,DELTA.thread.id]);
    await expect(row(page,DELTA)).toHaveCount(0);await expect(opening(page)).toHaveCount(0);await expect(hero(page)).toBeVisible();
    await expect(page.getByTestId("composer")).toBeEnabled();
    release();await expect.poll(()=>harness.sent("thread/goal/get").filter(id=>id===DELTA.thread.id).length).toBe(1);await page.waitForTimeout(500);
    await expect(row(page,DELTA)).toHaveCount(0);await expect(answer(page,DELTA)).toHaveCount(0);await expect(hero(page)).toBeVisible();
    expect(harness.threadMeta[DELTA.thread.id]?.archived).toBe(true);
  }finally{await harness.close()}
});

test("while a thread opens, the find bar, goal and review of the thread being left are out of reach, and a failed open brings them back",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});harness.server.git=true;
  const findBar=page.getByTestId("thread-find-bar"),objective=page.locator('textarea[aria-label="Objective"]'),panel=page.getByTestId("right-panel"),palette=page.getByRole("dialog");
  try{
    await start(page,harness);await openRow(page,ALPHA);
    // Release checklist's find bar and goal panel are open when another thread is clicked.
    await page.keyboard.press("Control+f");await page.getByTestId("thread-find-input").fill("answer");await expect(findBar).toContainText("No matches");
    await page.locator(".workspace-header .goal-control").click();await expect(objective).toBeVisible();
    harness.server.fail[GAMMA.thread.id]=FAILURE;let release=harness.hold(GAMMA.thread.id);
    await row(page,GAMMA).locator(".thread-main").click();await expect(opening(page)).toBeVisible();
    // Under the opening state the find bar hides and the goal panel waits for the thread; a failed open brings both back as they were.
    await expect(findBar).toBeHidden();await expect(objective).toBeHidden();await expect(panel).toContainText("Opening thread…");
    await page.screenshot({animations:"disabled",path:auditDir+"thread-opening-goal-panel-dark-1600x980.png"});
    release();
    await expect(page.locator(".sidebar-action-error")).toContainText(FAILURE);
    await expect(findBar).toBeVisible();await expect(page.getByTestId("thread-find-input")).toHaveValue("answer");await expect(objective).toBeVisible();
    // With both closed: the goal and find shortcuts and the command palette's thread actions wait for the thread too.
    await page.getByRole("button",{name:"Close find"}).click();await page.getByTestId("right-panel-toggle").click();await expect(panel).toHaveCount(0);
    release=harness.hold(BETA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await expect(opening(page)).toBeVisible();
    await page.keyboard.press("Control+Shift+L");await page.keyboard.press("Control+f");
    await page.keyboard.press("Control+k");await expect(palette).toBeVisible();
    await page.keyboard.type("Review changes");await expect(palette.getByText("Review changes",{exact:true})).toHaveCount(0);
    await page.keyboard.press("Control+a");await page.keyboard.type("Thread goal");await expect(palette.getByText("Thread goal",{exact:true})).toHaveCount(0);
    await page.keyboard.press("Escape");await expect(palette).toHaveCount(0);
    await expect(panel).toHaveCount(0);await expect(findBar).toHaveCount(0);
    expect([...harness.sent("review/start"),...harness.sent("thread/goal/set")]).toEqual([]);
    release();
    await expect(answer(page,BETA)).toBeVisible();await expect(page.getByTestId("composer")).toBeEnabled();
    // Opened, the thread has its own: the palette offers its review and the shortcut opens its goal.
    await expect(page.locator(".workspace-header .review-control")).toBeVisible();
    await page.keyboard.press("Control+k");await page.keyboard.type("Review changes");await expect(palette.getByText("Review changes",{exact:true}).first()).toBeVisible();
    await page.keyboard.press("Escape");await expect(palette).toHaveCount(0);
    await page.keyboard.press("Control+Shift+L");await expect(objective).toBeVisible();
  }finally{await harness.close()}
});

test("a thread of the harness that runs, clicked while another harness's thread switches the harness, opens there once the switch is undone",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA,CURSOR]});
  const composer=page.getByTestId("composer"),provider=page.locator(".sidebar-provider strong");
  try{
    await start(page,harness);await openRow(page,ALPHA);
    // A switch that fails puts back the thread, its row and the draft in the composer.
    await composer.fill("Draft kept across a failed open.");
    harness.server.selectFail="Cursor could not start: the harness is not signed in.";
    await row(page,CURSOR).locator(".thread-main").click();await expect.poll(()=>harness.server.selects).toBe(1);
    await expect(page.getByRole("alert").filter({hasText:"not signed in"}).first()).toBeVisible({timeout:15_000});
    await expect(opening(page)).toHaveCount(0);await expect(row(page,ALPHA)).toHaveClass(/active/);await expect(row(page,CURSOR)).not.toHaveClass(/active/);
    await expect(headerTitle(page)).toHaveText("Release checklist");await expect(answer(page,ALPHA,24)).toBeVisible();
    await expect(composer).toBeEnabled();await expect(composer).toHaveValue("Draft kept across a failed open.");
    // The person clicks the Cursor thread, then, while Cursor starts, a thread of OpenCode: it waits for the switch the server is in the
    // middle of, which then goes back to OpenCode, and opens there. The Cursor thread never opens.
    harness.server.selectFail=null;const releaseSelect=harness.holdSelect();
    await row(page,CURSOR).locator(".thread-main").click();await expect.poll(()=>harness.server.selects).toBe(2);
    await row(page,BETA).locator(".thread-main").click();
    await expect(row(page,BETA)).toHaveClass(/active/);await expect(headerTitle(page)).toHaveText("Payment retries");await expect(opening(page)).toBeVisible();
    await page.waitForTimeout(300);expect([harness.server.selects,harness.resumes(BETA.thread.id)]).toEqual([2,0]);
    releaseSelect();
    await expect.poll(()=>harness.server.selects).toBe(3);
    await expect(answer(page,BETA)).toBeVisible({timeout:15_000});await expect(opening(page)).toHaveCount(0);await expect(provider).toContainText("OpenCode");
    await page.waitForTimeout(500);
    await expect(row(page,BETA)).toHaveClass(/active/);await expect(headerTitle(page)).toHaveText("Payment retries");await expect(answer(page,CURSOR)).toHaveCount(0);
    expect([harness.server.runtime,harness.resumes(CURSOR.thread.id)]).toEqual(["opencode",0]);
    await expect(composer).toBeEnabled();await composer.fill("Follow-up on OpenCode.");await page.getByTestId("send").click();
    await expect(page.getByText("Fixture reply in "+BETA.thread.id,{exact:true})).toBeVisible({timeout:15_000});
    expect(harness.server.requests.filter(item=>item.method==="turn/start").map(item=>[item.runtime,item.params.threadId])).toEqual([["opencode",BETA.thread.id]]);
  }finally{await harness.close()}
});

test("a harness picked in Settings while a thread's own harness switch is on its way ends that thread's open",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,CURSOR]});
  const composer=page.getByTestId("composer");
  try{
    await start(page,harness);await openRow(page,ALPHA);
    const releaseSelect=harness.holdSelect();
    await row(page,CURSOR).locator(".thread-main").click();await expect.poll(()=>harness.server.selects).toBe(1);
    // While Cursor starts, the person picks Grok Build in Settings instead. Its switch lands last, so the Cursor thread never opens.
    await page.keyboard.press("Control+Comma");await expect(page.getByRole("heading",{name:"Settings",exact:true})).toBeVisible();
    await page.getByRole("button",{name:/Agents & models/}).click();await expect(page.getByRole("heading",{name:"Agent harness"})).toBeVisible();
    const grok=page.locator(".agent-runtime-option").filter({hasText:"Grok Build"}).locator("button").first();await expect(grok).toBeEnabled({timeout:10_000});await grok.click();
    releaseSelect();
    await expect.poll(()=>harness.server.selects,{timeout:10_000}).toBe(2);await expect(page.locator(".sidebar-provider strong")).toContainText("Grok",{timeout:15_000});
    await expect.poll(()=>harness.server.requests.filter(item=>item.runtime==="grok"&&item.method==="thread/list").length,{timeout:15_000}).toBeGreaterThan(0);
    // Back in the threads nothing is opening any more, and the composer takes a message for Grok.
    await page.getByRole("button",{name:"Threads",exact:true}).click();
    await expect(opening(page)).toHaveCount(0);await expect(composer).toBeEnabled();await expect(composer).not.toHaveAttribute("placeholder","Opening thread…");
    await expect(headerTitle(page)).toHaveText("New Trebell task");expect(harness.resumes(CURSOR.thread.id)).toBe(0);
  }finally{await harness.close()}
});

test("a turn that ends or starts while its thread opens shows as it is once the thread shows, and the next message starts a turn",async({page})=>{
  test.setTimeout(60_000);
  const RUNNING=savedThread("running-thread","Long migration",{minutesAgo:2});RUNNING.thread.status={type:"active",turnId:"running-thread-live"};
  const harness=await startHarness(page,{saved:[ALPHA,BETA,RUNNING]});
  const composer=page.getByTestId("composer"),stop=page.locator(".workspace-header .stop-control");
  try{
    await start(page,harness);await openRow(page,ALPHA);
    await expect(row(page,RUNNING).locator(".thread-running-dot")).toBeVisible();
    // The person opens the running thread. Its harness answers the resume with the turn still running, and the turn ends while the
    // app opens the thread's project (one quick request to the GUI server).
    harness.server.onProjectPost=async()=>{
      harness.server.onProjectPost=null;RUNNING.thread.status={type:"idle"};
      harness.emit({method:"turn/completed",params:{threadId:RUNNING.thread.id,turn:{id:"running-thread-live",status:"completed",completedAt:Date.now()/1000}}});
      await new Promise(resolve=>setTimeout(resolve,300));
    };
    await row(page,RUNNING).locator(".thread-main").click();
    await expect(answer(page,RUNNING)).toBeVisible({timeout:15_000});await expect(composer).toBeEnabled();
    // The turn is over: no Stop and no running dot, and the next message starts a turn instead of waiting behind one that ended.
    await expect(stop).toHaveCount(0);await expect(row(page,RUNNING).locator(".thread-running-dot")).toHaveCount(0);
    await composer.fill("Follow-up once the migration is done.");await page.getByTestId("send").click();
    await expect(page.getByText("Fixture reply in "+RUNNING.thread.id,{exact:true})).toBeVisible({timeout:15_000});
    expect(harness.sent("turn/start")).toEqual([RUNNING.thread.id]);
    // The other way round: a turn that starts, with its first command, while an idle thread opens shows running once the thread does.
    harness.server.onProjectPost=async()=>{
      harness.server.onProjectPost=null;
      harness.emit({method:"turn/started",params:{threadId:BETA.thread.id,turn:{id:"beta-live",status:"inProgress",startedAt:Date.now()/1000}}});
      harness.emit({method:"item/started",params:{threadId:BETA.thread.id,turnId:"beta-live",item:{id:"beta-command",type:"commandExecution",command:["npm","test"],status:"inProgress"}}});
      await new Promise(resolve=>setTimeout(resolve,300));
    };
    await row(page,BETA).locator(".thread-main").click();
    await expect(answer(page,BETA)).toBeVisible({timeout:15_000});await expect(composer).toBeEnabled();
    await expect(stop).toBeVisible();await expect(row(page,BETA).locator(".thread-running-dot")).toBeVisible();
    await expect(page.locator(".tool-event").filter({hasText:"npm test"})).toBeVisible();
  }finally{await harness.close()}
});

test("a thread whose open a later one or a new task replaces shows its turn in its row from then, not once its own open ends",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  const dot=row(page,BETA).locator(".thread-running-dot");let releaseProject=()=>{};
  // Payment retries' resume answers, and while its project opens (an answer that comes late) its harness starts a turn in it.
  const turnWhileProjectOpens=turnId=>{let posted=false;harness.server.onProjectPost=async()=>{harness.server.onProjectPost=null;posted=true;harness.emit({method:"turn/started",params:{threadId:BETA.thread.id,turn:{id:turnId,status:"inProgress",startedAt:Date.now()/1000}}});await new Promise(resolve=>{releaseProject=resolve})};return ()=>posted};
  try{
    await start(page,harness);await openRow(page,ALPHA);
    let posted=turnWhileProjectOpens("beta-first");
    await row(page,BETA).locator(".thread-main").click();await expect.poll(posted).toBe(true);
    // A thread that is slow to open replaces it: Payment retries is a thread in the background now, so its row says its turn runs.
    const releaseGamma=harness.hold(GAMMA.thread.id);
    await row(page,GAMMA).locator(".thread-main").click();await expect(headerTitle(page)).toHaveText("Flaky import");
    await expect(dot).toBeVisible();
    harness.emit({method:"turn/completed",params:{threadId:BETA.thread.id,turn:{id:"beta-first",status:"completed",completedAt:Date.now()/1000}}});await expect(dot).toHaveCount(0);
    releaseGamma();releaseProject();
    await expect(answer(page,GAMMA)).toBeVisible();await expect(page.getByTestId("composer")).toBeEnabled();await expect(answer(page,BETA)).toHaveCount(0);
    // A new task replaces it the same way.
    posted=turnWhileProjectOpens("beta-second");
    await row(page,BETA).locator(".thread-main").click();await expect.poll(posted).toBe(true);
    await page.getByRole("button",{name:"New thread",exact:true}).click();await expect(hero(page)).toBeVisible();
    await expect(dot).toBeVisible();
    releaseProject();await page.waitForTimeout(300);await expect(hero(page)).toBeVisible();await expect(dot).toBeVisible();
  }finally{releaseProject();await harness.close()}
});

test("a turn that ends while the first page of an opened thread's history is read shows ended once the thread shows, each step once on its card",async({page})=>{
  test.setTimeout(60_000);
  const PAGED=savedThread("paged-thread","Long migration",{minutesAgo:2});PAGED.thread.status={type:"active",turnId:"paged-thread-live"};
  const e2e=commandItem("paged-e2e","npm run e2e",{status:"inProgress"}),live={id:"paged-thread-live",status:"inProgress",items:[userItem("paged-live-ask","Run the suites."),commandItem("paged-build","npm run build"),e2e]};PAGED.thread.turns.push(live);
  const harness=await startHarness(page,{saved:[ALPHA,PAGED]});harness.server.turnsCursor[PAGED.thread.id]=true;
  const composer=page.getByTestId("composer"),stop=page.locator(".workspace-header .stop-control");
  try{
    await start(page,harness);await openRow(page,ALPHA);
    // Its harness pages history: the resume answers with the turn running, and while the app reads the first page the turn's last
    // step and the turn end.
    harness.server.onTurnsList=async()=>{
      harness.server.onTurnsList=null;PAGED.thread.status={type:"idle"};
      Object.assign(e2e,{status:"completed",aggregatedOutput:"ok\n",exitCode:0});harness.emit({method:"item/completed",params:{threadId:PAGED.thread.id,turnId:live.id,item:{...e2e}}});
      const reply={id:"paged-live-answer",type:"agentMessage",text:"Both suites pass."};live.items.push(reply);harness.emit({method:"item/completed",params:{threadId:PAGED.thread.id,turnId:live.id,item:reply}});
      live.status="completed";harness.emit({method:"turn/completed",params:{threadId:PAGED.thread.id,turn:{id:live.id,status:"completed",completedAt:Date.now()/1000}}});
      await new Promise(resolve=>setTimeout(resolve,150));
    };
    await row(page,PAGED).locator(".thread-main").click();
    await expect(page.locator('[data-message-id="paged-live-answer"]')).toBeVisible({timeout:15_000});await expect(composer).toBeEnabled();
    await expect(stop).toHaveCount(0);await expect(row(page,PAGED).locator(".thread-running-dot")).toHaveCount(0);
    // Each step shows once, done, on the turn's own card, as if the turn had ended before the open.
    for(const text of ["npm run build","npm run e2e"])await expect(steps(page,text),text).toHaveCount(1);
    await expect(page.locator(".conversation-column .tool-event.status-running")).toHaveCount(0);
    await expect(page.locator('[data-testid=activity-card][data-turn-id="paged-thread-live"]')).toHaveCount(1);
    await shootConversation(page,"opened-turn-ended",steps(page,"npm run e2e"));
    await composer.fill("Follow-up once the migration is done.");await page.getByTestId("send").click();
    await expect(page.getByText("Fixture reply in "+PAGED.thread.id,{exact:true})).toBeVisible({timeout:15_000});
    expect(harness.sent("turn/start")).toEqual([PAGED.thread.id]);
  }finally{await harness.close()}
});

test("a turn the harness starts again under its id while its thread opens keeps the steps it had on the live card",async({page})=>{
  test.setTimeout(60_000);
  const CUT=savedThread("cut-thread","Recovered migration",{minutesAgo:2});
  const cut={id:"cut-thread-cut",status:"interrupted",items:[userItem("cut-ask","Run the migration."),commandItem("cut-build","npm run build")]};CUT.thread.turns.push(cut);
  const harness=await startHarness(page,{saved:[ALPHA,CUT]});harness.server.turnsCursor[CUT.thread.id]=true;
  try{
    await start(page,harness);await openRow(page,ALPHA);
    // The harness came back from a restart and runs the cut turn again under its id (the relay's restart recovery) as the person
    // opens the thread: the resume answers idle, and the turn starts again with a new step while the first page is read.
    harness.server.onTurnsList=async()=>{
      harness.server.onTurnsList=null;CUT.thread.status={type:"active",turnId:cut.id};cut.status="inProgress";
      const retry=commandItem("cut-retry","npm run retry",{status:"inProgress"});cut.items.push(retry);
      harness.emit({method:"turn/started",params:{threadId:CUT.thread.id,turn:{id:cut.id,status:"inProgress",startedAt:Date.now()/1000}}});
      harness.emit({method:"item/started",params:{threadId:CUT.thread.id,turnId:cut.id,item:{...retry}}});
      await new Promise(resolve=>setTimeout(resolve,150));
    };
    await row(page,CUT).locator(".thread-main").click();
    await expect(answer(page,CUT)).toBeVisible({timeout:15_000});await expect(page.locator(".workspace-header .stop-control")).toBeVisible();
    // The live card is the turn's: the step it ran before the restart, then the one it runs now, once each.
    const live=page.locator(".agent-block [data-testid=activity-card]");
    await expect(live).toHaveAttribute("data-turn-id",cut.id);await expect(live.locator(".activity-card-summary")).toHaveText("2 steps");
    await expect(steps(page,"npm run build")).toHaveCount(1);await expect(live.locator(".tool-event").filter({hasText:"npm run build"})).toHaveCount(1);
    await expect(steps(page,"npm run retry")).toHaveCount(1);await expect(steps(page,"npm run retry").locator("summary em")).toHaveText("running");
    await shootConversation(page,"opened-turn-started-again",live);
  }finally{await harness.close()}
});

test("a thread clicked while a restarted harness reopens the thread shown opens, and if it fails the thread shown still resumes on the new connection",async({page})=>{
  test.setTimeout(90_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});harness.server.fail[GAMMA.thread.id]=FAILURE;
  const composer=page.getByTestId("composer"),stop=page.locator(".workspace-header .stop-control");
  try{
    await start(page,harness);await openRow(page,BETA);
    expect(harness.resumes(BETA.thread.id)).toBe(1);
    // A server restart: the app connects again, lists the threads and reopens Payment retries, whose worktree check answers a moment
    // late. Meanwhile the person clicks a thread that turns out not to open.
    const releaseWorktree=harness.holdWorktree();harness.drop();
    await expect.poll(()=>harness.server.worktreeHeld,{timeout:15_000}).toBe(true);
    let releaseOpen=harness.hold(GAMMA.thread.id);
    await row(page,GAMMA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(GAMMA.thread.id)).toBe(1);
    releaseWorktree();await page.waitForTimeout(300);
    releaseOpen();
    await expect(page.locator(".sidebar-action-error")).toContainText(FAILURE);
    await expect(headerTitle(page)).toHaveText("Payment retries");await expect(row(page,BETA)).toHaveClass(/active/);
    // Payment retries is the thread shown after the restart, so it still resumes on the new connection.
    await expect.poll(()=>harness.resumes(BETA.thread.id),{timeout:5_000}).toBe(2);await expect(composer).toBeEnabled();
    // Again while Payment retries runs, and this time the click comes while the restarted harness answers its resume, late. The
    // restart ended the turn, so the harness has the thread idle: shown again, the thread is as the harness has it.
    harness.emit({method:"turn/started",params:{threadId:BETA.thread.id,turn:{id:"beta-live",status:"inProgress",startedAt:Date.now()/1000}}});
    await expect(stop).toBeVisible();
    const releaseReopen=harness.hold(BETA.thread.id);harness.drop();
    await expect.poll(()=>harness.resumes(BETA.thread.id),{timeout:15_000}).toBe(3);
    releaseOpen=harness.hold(GAMMA.thread.id);
    await row(page,GAMMA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(GAMMA.thread.id)).toBe(2);
    releaseReopen();await page.waitForTimeout(300);
    releaseOpen();
    await expect.poll(()=>harness.resumes(BETA.thread.id),{timeout:5_000}).toBe(4);
    await expect(headerTitle(page)).toHaveText("Payment retries");await expect(row(page,BETA)).toHaveClass(/active/);await expect(composer).toBeEnabled();
    await expect(stop).toHaveCount(0);
    await composer.fill("Follow-up after the restart.");await page.getByTestId("send").click();
    await expect(page.getByText("Fixture reply in "+BETA.thread.id,{exact:true})).toBeVisible({timeout:15_000});
    expect(harness.sent("turn/start")).toEqual([BETA.thread.id]);
  }finally{await harness.close()}
});

test("while a thread opens, an approval from the thread being left says whose it is",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  const panel=page.getByTestId("right-panel"),label=panel.locator(".approval-card").getByTestId("approval-thread");
  try{
    await start(page,harness);await openRow(page,ALPHA);
    await page.getByTestId("right-panel-toggle").click();await panel.getByRole("button",{name:"Runtime",exact:true}).click();
    await expect(panel.locator(".runtime-summary")).toBeVisible();
    const release=harness.hold(BETA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await expect(headerTitle(page)).toHaveText("Payment retries");
    // Release checklist's agent asks to run a command while Payment retries opens, under a header that names Payment retries: the
    // card says whose command it is, in the conversation before the opening state covers it and in the Runtime panel.
    harness.serverRequest("item/commandExecution/requestApproval",{threadId:ALPHA.thread.id,turnId:"alpha-live",itemId:"alpha-command",command:["rm","-rf","build"],reason:"Clean the build folder"});
    await expect(label).toHaveText("Waiting in Release checklist");
    await expect(page.locator(".inline-approval").getByTestId("approval-thread")).toHaveText("Waiting in Release checklist");
    await expect(opening(page)).toBeVisible();await expect(label).toHaveText("Waiting in Release checklist");
    release();
    await expect(answer(page,BETA)).toBeVisible();await expect(label).toHaveText("Waiting in Release checklist");
  }finally{await harness.close()}
});

test("a goal being drafted in the thread being left comes back when the open fails, and a thread that opens starts its own",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});harness.server.fail[GAMMA.thread.id]=FAILURE;
  const objective=page.locator('textarea[aria-label="Objective"]'),panel=page.getByTestId("right-panel");
  try{
    await start(page,harness);await openRow(page,ALPHA);
    await page.locator(".workspace-header .goal-control").click();await objective.fill("Ship the release checklist by Friday");
    let release=harness.hold(GAMMA.thread.id);
    await row(page,GAMMA).locator(".thread-main").click();await expect(opening(page)).toBeVisible();
    // The goal panel waits for the thread being opened; the draft of the thread being left only hides.
    await expect(objective).toBeHidden();await expect(panel).toContainText("Opening thread…");
    release();
    await expect(page.locator(".sidebar-action-error")).toContainText(FAILURE);await expect(headerTitle(page)).toHaveText("Release checklist");
    await expect(objective).toBeVisible();await expect(objective).toHaveValue("Ship the release checklist by Friday");
    // A thread that opens has its own goal panel, without the draft of the thread it replaced.
    release=harness.hold(BETA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await expect(opening(page)).toBeVisible();await expect(objective).toBeHidden();
    release();
    await expect(answer(page,BETA)).toBeVisible();await expect(objective).toBeVisible();await expect(objective).toHaveValue("");
  }finally{await harness.close()}
});

test("a thread clicked again while it opens shows when that open answers instead of opening again",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  try{
    await start(page,harness);await openRow(page,ALPHA);
    // Every resume of Payment retries takes as long (a slow harness). The person clicks it, and clicks it again while it opens.
    const first=harness.hold(BETA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(BETA.thread.id)).toBe(1);
    const second=harness.hold(BETA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await page.waitForTimeout(300);
    try{
      expect(harness.resumes(BETA.thread.id)).toBe(1);
      await expect(opening(page)).toBeVisible();await expect(headerTitle(page)).toHaveText("Payment retries");
      // The first answer comes: the thread shows then.
      first();
      await expect(answer(page,BETA)).toBeVisible({timeout:5_000});await expect(page.getByTestId("composer")).toBeEnabled();
      await expect(opening(page)).toHaveCount(0);expect(harness.resumes(BETA.thread.id)).toBe(1);
    }finally{first();second()}
  }finally{await harness.close()}
});

test("while a thread opens, the composer's mode picker waits for it instead of changing the thread being left, and a quick open leaves it as it is",async({page})=>{
  test.setTimeout(60_000);
  const LEFT=savedThread("left-thread","Cursor refactor",{runtime:"cursor",minutesAgo:4,projectless:true});
  const NEXT=savedThread("next-thread","Cursor tests",{runtime:"cursor",minutesAgo:8,projectless:true});
  const harness=await startHarness(page,{runtime:"cursor",saved:[LEFT,NEXT]});
  harness.server.modes=[{name:"Plan",mode:"plan",model:null,reasoning_effort:"medium"},{name:"Default",mode:"default",model:null,reasoning_effort:null}];
  const picker=page.getByTestId("collaboration-mode-picker"),updates=()=>harness.server.requests.filter(item=>item.method==="thread/settings/update").map(item=>item.params.threadId);
  try{
    await page.goto("/");await expect(row(page,LEFT)).toBeVisible({timeout:15_000});await expect(page.getByTestId("composer")).toBeEnabled({timeout:15_000});
    await openRow(page,LEFT);await expect(picker).toHaveValue("default");await expect(picker).toBeEnabled();
    // A quick open, whose resume answers in a few frames: frame by frame the picker stays as it is.
    harness.server.resumeDelay[NEXT.thread.id]=80;
    await startFrames(page);await openRow(page,NEXT);await frames(page,4);
    const quick=await stopFrames(page);
    expect(quick.filter(frame=>frame.opening),"no opening state in a quick open: "+JSON.stringify(quick)).toEqual([]);
    expect(quick.filter(frame=>frame.composer.includes("dimmed")),"frames with the picker dimmed: "+JSON.stringify(quick)).toEqual([]);
    // A slow one, back to Cursor refactor. A pick in the moment after the click, before the opening state shows, changes no thread.
    const release=harness.hold(LEFT.thread.id);
    await page.evaluate(async id=>{
      document.querySelector(`.thread-row[data-thread-id="${id}"] .thread-main`).click();await new Promise(resolve=>setTimeout(resolve,0));
      const select=document.querySelector("[data-testid=collaboration-mode-picker]");select.value="plan";select.dispatchEvent(new Event("change",{bubbles:true}));
    },LEFT.thread.id);
    await expect(headerTitle(page)).toHaveText("Cursor refactor");await expect(picker).toHaveValue("default");
    // Once the opening state shows, the picker, whose mode is the open thread's, waits for the thread.
    await expect(opening(page)).toBeVisible();await expect(picker).toBeDisabled();
    release();
    await expect(answer(page,LEFT)).toBeVisible();await expect(picker).toBeEnabled();
    // Opened, the thread takes the mode picked for it; the thread left never had its mode changed.
    await picker.selectOption("plan");await expect.poll(updates).toEqual([LEFT.thread.id]);
  }finally{await harness.close()}
});

test("a thread of another project is named by that project in the crumb from the click, never by its folder",async({page})=>{
  test.setTimeout(60_000);
  // A project whose name is not its folder's: Website, in the folder ui.
  const SITE_PATH=process.cwd().replace(/[\\/]+$/,"")+(process.platform==="win32"?"\\":"/")+"ui";
  const SITE=savedThread("site-thread","Landing page copy",{minutesAgo:20});SITE.thread.cwd=SITE_PATH;
  const harness=await startHarness(page,{saved:[ALPHA,BETA,SITE],extraProjects:[{id:"site-project",name:"Website",path:SITE_PATH,environmentId:null,effectiveSettings:{}}]});
  const sampleCrumbs=()=>page.evaluate(()=>{
    const run=window.__crumbRun=(window.__crumbRun||0)+1;window.__crumbs=[];
    const sample=()=>{const text=document.querySelector(".workspace-header .project-crumb:not(.sidebar-reopen) span")?.textContent||"";if(window.__crumbs.at(-1)!==text)window.__crumbs.push(text);if(window.__crumbRun===run)requestAnimationFrame(sample)};
    requestAnimationFrame(sample);
  });
  const sampledCrumbs=()=>page.evaluate(()=>{window.__crumbRun++;return window.__crumbs});
  try{
    await start(page,harness);await openRow(page,ALPHA);await expect(projectCrumb(page)).toHaveText(PROJECT_NAME);
    // A quick open: frame by frame the crumb names the project before the click, then the thread's.
    await sampleCrumbs();
    await openRow(page,SITE);await expect(projectCrumb(page)).toHaveText("Website");await frames(page,4);
    expect(await sampledCrumbs()).toEqual([PROJECT_NAME,"Website"]);
    // A slow one names it from the click.
    await openRow(page,ALPHA);await expect(projectCrumb(page)).toHaveText(PROJECT_NAME);
    const release=harness.hold(SITE.thread.id);
    await row(page,SITE).locator(".thread-main").click();await expect(opening(page)).toBeVisible();
    await expect(headerTitle(page)).toHaveText("Landing page copy");await expect(projectCrumb(page)).toHaveText("Website");
    release();
    await expect(answer(page,SITE)).toBeVisible();await expect(projectCrumb(page)).toHaveText("Website");
  }finally{await harness.close()}
});

// Removed on Projects, a project no longer names its thread while that thread opens: the crumb shows the folder, as for a folder
// with no project. Put back by Undo (under a new id), it names the thread again from the click.
test("a thread of a project removed on Projects is named by its folder while it opens, and by the project once Undo puts it back",async({page})=>{
  test.setTimeout(60_000);
  const SITE_PATH=process.cwd().replace(/[\\/]+$/,"")+(process.platform==="win32"?"\\":"/")+"ui";
  const SITE=savedThread("site-removed-thread","Landing page copy",{minutesAgo:20});SITE.thread.cwd=SITE_PATH;
  const harness=await startHarness(page,{saved:[ALPHA,BETA,SITE]});
  // The project list as Trebell's server keeps it: a removal drops the record, a restore or an open of a folder without one adds it.
  let records=[{id:"opening-project",name:PROJECT_NAME,path:process.cwd(),environmentId:null,effectiveSettings:{}},{id:"site-project",name:"Website",path:SITE_PATH,environmentId:null,effectiveSettings:{}}],added=0;
  await page.route(/\/api\/projects(?:\?.*)?$/,route=>{
    const request=route.request();
    if(request.method()==="GET")return json(route,{projects:records});
    if(request.method()==="DELETE"){const id=new URL(request.url()).searchParams.get("id");records=records.filter(item=>item.id!==id);return json(route,{ok:true})}
    const body=request.postDataJSON()||{};let project=records.find(item=>item.path===body.path);
    if(!project){project={id:"site-project-"+(++added),name:body.name||String(body.path).split(/[\\/]/).pop(),path:body.path,environmentId:null,effectiveSettings:{}};records=[project,...records]}
    return json(route,{project});
  });
  const nav=label=>page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:label,exact:true});
  const removeSite=()=>page.locator(".project-card").filter({hasText:"Website"}).getByRole("button",{name:"Remove Website",exact:true}).click();
  const toast=page.getByTestId("thread-undo-toast");
  const openSlowly=async(crumb,{shots=false}={})=>{
    const release=harness.hold(SITE.thread.id);
    await row(page,SITE).locator(".thread-main").click();await expect(opening(page)).toBeVisible();
    await expect(headerTitle(page)).toHaveText("Landing page copy");
    await expect(projectCrumb(page),"the crumb of the thread opening").toHaveText(crumb);
    if(shots)for(const [width,mode] of [[1280,"dark"],[1280,"light"],[900,"light"],[900,"dark"]]){
      await page.setViewportSize({width,height:800});await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
      await expect(projectCrumb(page)).toHaveText(crumb);
      await page.screenshot({animations:"disabled",path:auditDir+`polish/thread-opening/removed-project-opening-${mode}-${width}.png`});
    }
    release();await expect(answer(page,SITE)).toBeVisible();
  };
  try{
    await page.setViewportSize({width:1280,height:800});
    await start(page,harness);await openRow(page,ALPHA);await expect(projectCrumb(page)).toHaveText(PROJECT_NAME);
    // Removed and put back at once: the project names its thread again, under its new id.
    await nav("Projects").click();await removeSite();
    await toast.getByRole("button",{name:"Undo",exact:true}).click();await expect(toast).toHaveCount(0);
    await expect.poll(()=>records.find(item=>item.path===SITE_PATH)?.id).toBe("site-project-1");
    await openRow(page,ALPHA);
    await openSlowly("Website");
    // Removed for good: its thread is named by its folder while it opens.
    await openRow(page,ALPHA);
    await nav("Projects").click();await removeSite();await expect(toast).toBeVisible();
    await expect.poll(()=>records.some(item=>item.path===SITE_PATH)).toBe(false);
    await nav("New task").click();await expect(projectCrumb(page)).toHaveText(PROJECT_NAME);
    await openSlowly("ui",{shots:true});
  }finally{await harness.close()}
});

// A thread's notifications are held from the answer of its first resume, before its history is read. What the harness sends
// while that history is read is already in it, so the held notifications are handled on top of it without doubling anything,
// and a turn they start and end is timed from when they came. The turn runs one command, which shows once, on the turn's own card.
async function runAndEndTurn(harness,saved,turnId){
  const threadId=saved.thread.id,lint=commandItem(turnId+"-lint","npm run lint",{status:"inProgress"});
  harness.emit({method:"turn/started",params:{threadId,turn:{id:turnId,status:"inProgress",startedAt:Date.now()/1000}}});
  harness.emit({method:"item/started",params:{threadId,turnId,item:lint}});
  await new Promise(resolve=>setTimeout(resolve,1200));
  const linted=commandItem(lint.id,lint.command);
  saved.thread.turns.push({id:turnId,status:"completed",items:[userItem(turnId+"-ask","Live question."),linted,{id:turnId+"-answer",type:"agentMessage",text:"Live answer."}]});
  harness.emit({method:"item/completed",params:{threadId,turnId,item:linted}});
  harness.emit({method:"item/completed",params:{threadId,turnId,item:{id:turnId+"-answer",type:"agentMessage",text:"Live answer."}}});
  harness.emit({method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed",completedAt:Date.now()/1000}}});
  await new Promise(resolve=>setTimeout(resolve,50));
}

test("a turn that runs and ends while an opened thread's whole history is read keeps its measured done pill and its step once",async({page})=>{
  test.setTimeout(60_000);
  const QUIET=savedThread("quiet-thread","Quiet refactor",{minutesAgo:3});
  const harness=await startHarness(page,{saved:[ALPHA,QUIET]});
  try{
    await start(page,harness);await openRow(page,ALPHA);
    harness.server.onFullResume=async threadId=>{if(threadId!==QUIET.thread.id)return;harness.server.onFullResume=null;await runAndEndTurn(harness,QUIET,"quiet-live")};
    await row(page,QUIET).locator(".thread-main").click();
    const reply=page.locator('[data-message-id="quiet-live-answer"]');
    await expect(reply).toBeVisible({timeout:15_000});await expect(page.getByTestId("composer")).toBeEnabled();await page.waitForTimeout(300);
    await expect(reply).toHaveCount(1);
    // The turn ran about 1.2 s, and its reply says so, as it does when the same turn ends while another thread is open.
    await expect(reply.getByTestId("turn-outcome")).toHaveText(/^done · 1\.\ds$/);
    await expect(steps(page,"npm run lint")).toHaveCount(1);await expect(page.locator('[data-testid=activity-card][data-turn-id="quiet-live"]')).toHaveCount(1);
    await expect(page.locator(".conversation-column .tool-event.status-running")).toHaveCount(0);
  }finally{await harness.close()}
});

test("a turn that runs and ends while an opened thread's first history page is read keeps its measured done pill and its step once",async({page})=>{
  test.setTimeout(60_000);
  const PAGED=savedThread("paged-quiet","Paged refactor",{minutesAgo:3});
  const harness=await startHarness(page,{saved:[ALPHA,PAGED]});harness.server.turnsCursor[PAGED.thread.id]=true;
  try{
    await start(page,harness);await openRow(page,ALPHA);
    harness.server.onTurnsList=async()=>{harness.server.onTurnsList=null;await runAndEndTurn(harness,PAGED,"paged-live")};
    await row(page,PAGED).locator(".thread-main").click();
    const reply=page.locator('[data-message-id="paged-live-answer"]');
    await expect(reply).toBeVisible({timeout:15_000});await expect(page.getByTestId("composer")).toBeEnabled();await page.waitForTimeout(300);
    await expect(reply).toHaveCount(1);
    await expect(reply.getByTestId("turn-outcome")).toHaveText(/^done · 1\.\ds$/);
    await expect(steps(page,"npm run lint")).toHaveCount(1);await expect(page.locator('[data-testid=activity-card][data-turn-id="paged-live"]')).toHaveCount(1);
    await expect(page.locator(".conversation-column .tool-event.status-running")).toHaveCount(0);
    await shootConversation(page,"opened-turn-ran",steps(page,"npm run lint"));
  }finally{await harness.close()}
});

test("a queued follow-up the harness starts while an opened thread's whole history is read shows once",async({page})=>{
  test.setTimeout(60_000);
  const BUSY=savedThread("busy-thread","Busy migration",{minutesAgo:2});BUSY.thread.status={type:"active",turnId:"busy-thread-run"};
  const harness=await startHarness(page,{saved:[ALPHA,BUSY]});
  try{
    await start(page,harness);await openRow(page,ALPHA);
    // While the whole history is read, the running turn ends and the harness starts the follow-up queued in it (its native queue).
    harness.server.onFullResume=async threadId=>{
      if(threadId!==BUSY.thread.id)return;harness.server.onFullResume=null;
      harness.emit({method:"turn/completed",params:{threadId,turn:{id:"busy-thread-run",status:"completed",completedAt:Date.now()/1000}}});
      harness.emit({method:"turn/started",params:{threadId,turn:{id:"busy-thread-next",status:"inProgress",startedAt:Date.now()/1000}}});
      const ask={id:"busy-next-ask",type:"userMessage",clientId:"trebell-queue-verify",content:[{type:"text",text:"Queued follow-up."}]};
      harness.emit({method:"item/completed",params:{threadId,turnId:"busy-thread-next",item:ask}});
      BUSY.thread.turns.push({id:"busy-thread-next",status:"inProgress",items:[ask]});BUSY.thread.status={type:"active",turnId:"busy-thread-next"};
      await new Promise(resolve=>setTimeout(resolve,100));
    };
    await row(page,BUSY).locator(".thread-main").click();
    await expect(answer(page,BUSY)).toBeVisible({timeout:15_000});await page.waitForTimeout(300);
    await expect(page.locator(".conversation-column .user-row").filter({hasText:"Queued follow-up."})).toHaveCount(1);
  }finally{await harness.close()}
});
