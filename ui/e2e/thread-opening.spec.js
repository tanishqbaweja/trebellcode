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
const HARNESSES=[["opencode","OpenCode","sdk","opencode/fixture-fast"],["cursor","Cursor","acp","cursor-fixture"]];
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

// One socket URL for both harnesses, as the agent relay serves them: each request is answered by the harness active when it arrives.
// hold(threadId) holds that thread's next thread/resume until the function it returns is called; fail[threadId] fails its resume.
// The GUI server around it is faked with routes: the app starts in PROJECT_NAME (the repository folder), and holdSelect(), when
// set, holds the answer of a harness switch (the runtime changes at once). server.projectDelay slows the answer of a project
// opening, and server.git makes the project a Git repository.
async function startHarness(page,{runtime="opencode",saved=[]}={}){
  const server={runtime,requests:[],holds:new Map(),fail:{},selects:0,selectHold:null,turns:0,projectDelay:0,git:false};
  const threads=saved.map(item=>item.thread),threadMeta=Object.fromEntries(saved.map(item=>[item.thread.id,item.meta]));
  const project={id:"opening-project",name:PROJECT_NAME,path:process.cwd(),environmentId:null,effectiveSettings:{}};
  const http=createServer(),wss=new WebSocketServer({noServer:true});
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",async raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
    const params=message.params||{},active=server.runtime;server.requests.push({runtime:active,method:message.method,params});
    const send=value=>{if(ws.readyState===1)ws.send(JSON.stringify(value))};
    if(message.method==="thread/resume"){
      const held=params.excludeTurns!==false?server.holds.get(params.threadId):null;
      if(held){server.holds.delete(params.threadId);await held}
      const thread=threads.find(item=>item.id===params.threadId);
      if(server.fail[params.threadId]||!thread)return send({id:message.id,error:{code:-32000,message:server.fail[params.threadId]||"Unknown fixture thread"}});
      return send({id:message.id,result:{thread:{...thread,turns:params.excludeTurns===false?thread.turns:[]},itemsBackwardsCursor:null,turnsBackwardsCursor:null}});
    }
    if(message.method==="turn/start"){
      const threadId=params.threadId,turnId=active+"-live-turn-"+(++server.turns);
      send({id:message.id,result:{turn:{id:turnId,status:"inProgress",items:[]}}});
      send({method:"turn/started",params:{threadId,turn:{id:turnId,status:"inProgress",startedAt:Date.now()/1000}}});
      send({method:"item/completed",params:{threadId,turnId,item:{id:"reply-"+turnId,type:"agentMessage",text:"Fixture reply in "+threadId}}});
      send({method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed",completedAt:Date.now()/1000}}});
      return;
    }
    let result={};
    if(message.method==="initialize")result={userAgent:"thread-opening-fixture"};
    else if(message.method==="thread/list")result={data:threads.filter(item=>item.runtime===active).map(item=>({...item,turns:[]})),nextCursor:null};
    else if(["thread/turns/list","thread/queue/list","thread/attachment/list","thread/timeline/list","thread/items/list"].includes(message.method))result={data:[],nextCursor:null};
    else if(["threadSection/list","skills/list","collaborationMode/list"].includes(message.method))result={data:[]};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
    send({id:message.id,result});
  }));
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  const wsUrl="ws://127.0.0.1:"+port+"/api/agent/ws";
  const settings=()=>({onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:server.runtime,agentRuntimeInstanceId:server.runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue",activeProjectId:project.id,keybindingRules:[{command:"threadPin",key:"Ctrl+Alt+P",when:"threadOpen && !modalOpen"},{command:"threadNext",key:"Ctrl+Alt+J",when:"threadOpen && !modalOpen"}]});
  const bootstrap=()=>({mock:false,provider:"openai",providerReady:true,agentRuntime:server.runtime,agentRuntimeInstanceId:server.runtime+"-default",agentRuntimeReady:true,appServerReady:true,wsUrl,cwd:process.cwd(),platform:process.platform,version:"thread-opening-fixture",activeEnvironmentId:null,activeEnvironment:null});
  const snapshot=()=>{
    const statuses=HARNESSES.map(([kind,name])=>({id:kind+"-default",kind,name,available:true,installed:true,authenticated:true,version:"1.0.0-fixture"}));
    return {selectedRuntime:server.runtime,selectedInstanceId:server.runtime+"-default",definitions:HARNESSES.map(([id,name,protocol])=>({id,name,protocol,multipleInstances:false})),instances:statuses.map(({id,kind,name})=>({id,kind,displayName:name,enabled:true})),statuses};
  };
  await page.route(/\/api\/bootstrap$/,route=>json(route,bootstrap()));
  await page.route(/\/api\/state$/,route=>json(route,{settings:settings(),projects:[project],threadMeta}));
  await page.route(/\/api\/settings$/,route=>json(route,settings()));
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,CATALOGS[server.runtime]));
  await page.route(/\/api\/agent-runtimes(?:\?.*)?$/,async route=>{
    if(route.request().method()==="GET")return json(route,snapshot());
    const body=route.request().postDataJSON()||{};server.selects++;server.runtime=body.runtime;
    if(server.selectHold)await server.selectHold;
    const current=snapshot();
    return json(route,{...current,selected:{runtime:server.runtime,instance:current.instances.find(item=>item.kind===server.runtime),status:current.statuses.find(item=>item.kind===server.runtime)},bootstrap:bootstrap(),catalog:CATALOGS[server.runtime]});
  });
  await page.route(/\/api\/providers$/,route=>json(route,{selected:"openai",providers:[{id:"openai",name:"OpenAI API",official:true,hasKey:true}],status:{id:"openai",hasKey:true},ready:true}));
  await page.route(/\/api\/projects$/,async route=>{
    if(route.request().method()==="GET")return json(route,{projects:[project]});
    if(server.projectDelay)await new Promise(resolve=>setTimeout(resolve,server.projectDelay));
    return json(route,{project});
  });
  await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true,path:process.cwd()}));
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
    server,
    hold(threadId){let release=()=>{};server.holds.set(threadId,new Promise(resolve=>{release=resolve}));return release},
    holdSelect(){let release=()=>{};server.selectHold=new Promise(resolve=>{release=resolve});return ()=>{server.selectHold=null;release()}},
    resumes:threadId=>server.requests.filter(item=>item.method==="thread/resume"&&item.params.threadId===threadId&&item.params.excludeTurns!==false).length,
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

// Samples every frame until stopFrames: the header title, the selected row, and whether the opening state, the new-task hero and
// each thread's messages are on screen, with the time since the first click after startFrames.
async function startFrames(page){
  await page.evaluate(()=>{
    const shown=node=>Boolean(node&&node.checkVisibility({visibilityProperty:true}));
    const run=window.__framesRun=(window.__framesRun||0)+1;window.__frames=[];window.__clickAt=null;
    document.addEventListener("click",()=>{if(window.__clickAt==null)window.__clickAt=performance.now()},{capture:true,once:true});
    const sample=()=>{
      const threads=[...new Set([...document.querySelectorAll(".conversation-column [data-message-id]")].filter(shown).map(node=>String(node.dataset.messageId).split("-")[0]))];
      window.__frames.push({at:performance.now(),title:document.querySelector(".workspace-header .thread-title-button strong")?.textContent||"",row:document.querySelector(".thread-row.active")?.dataset.threadId||null,opening:shown(document.querySelector("[data-testid=thread-opening]")),hero:shown(document.querySelector(".conversation-column .welcome")),threads});
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
    await scroller.evaluate(node=>{node.scrollTop=Math.round((node.scrollHeight-node.clientHeight)/2)});await frames(page,3);
    const before=await scroller.evaluate(node=>node.scrollTop);expect(before).toBeGreaterThan(200);
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

test("while a thread opens, the thread shortcuts follow the thread the header names",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  try{
    await start(page,harness);await openRow(page,ALPHA);
    const moves=()=>harness.server.requests.filter(item=>item.method==="thread/section/move");
    const releaseBeta=harness.hold(BETA.thread.id),releaseGamma=harness.hold(GAMMA.thread.id);
    await row(page,BETA).locator(".thread-main").click();await expect.poll(()=>harness.resumes(BETA.thread.id)).toBe(1);
    await expect(headerTitle(page)).toHaveText("Payment retries");
    // Pin waits for the thread being opened instead of pinning the one the view is leaving.
    await page.keyboard.press("Control+Alt+P");await page.waitForTimeout(300);expect(moves()).toHaveLength(0);
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

test("the thread already open shows no opening state, and a quick open never flashes one, the new-task screen or an empty view",async({page})=>{
  test.setTimeout(60_000);
  const harness=await startHarness(page,{saved:[ALPHA,BETA,GAMMA,DELTA]});
  try{
    await start(page,harness);
    // Quick opens: from the new-task screen, then from a thread to a project thread and to a General chat thread. The project opens
    // in a few frames, as a real server's does: that used to show the empty new-task screen between two project threads.
    harness.server.projectDelay=40;
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
