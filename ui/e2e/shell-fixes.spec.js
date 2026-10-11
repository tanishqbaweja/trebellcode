import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

// The conversation's activity rows, the thread sidebar, the workspace header and the app shell at narrow widths, against a
// fake harness socket (as in reasoning-text.spec.js).
const shotsDir=process.env.TREBELL_E2E_SHOTS_DIR||fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(shotsDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The harness end of the agent socket: it lists the threads, starts the turns it is sent, records every request, and pushes
// what the test sends.
async function startHarness(threads){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set(),requests=[];
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{sockets.add(ws);ws.on("close",()=>sockets.delete(ws));ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push({method:message.method,params:message.params});let result={};
    const thread=threads.find(item=>item.id===message.params?.threadId)||threads[0];
    if(message.method==="initialize")result={userAgent:"shell-fixes-fixture"};
    else if(message.method==="thread/list")result={data:threads.map(item=>({...item,turns:[]})),nextCursor:null};
    else if(message.method==="thread/resume")result=message.params?.excludeTurns?{thread:{...thread,turns:[]}}:{thread};
    else if(message.method==="turn/start")result={turn:{id:"turn-live",status:"inProgress",items:[]}};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(/\/list$/.test(message.method))result={data:[],nextCursor:null};
    ws.send(JSON.stringify({id:message.id,result}));
  })});
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",requests,
    push(method,params){for(const ws of sockets)ws.send(JSON.stringify({method,params}))},
    async close(){for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
}

async function openApp(page,{harness,threads,meta,project=null,runtime="codex",settings={},layout={sidebarWidth:258,rightPanelWidth:460,terminalHeight:330},cwd=process.cwd()}){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  const appSettings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",...(project?{activeProjectId:project.id}:{}),...settings};
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd,platform:process.platform,version:"shell-fixes-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:appSettings,projects:project?[project]:[],threadMeta:meta}));
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,{...appSettings,...(route.request().postDataJSON()||{})}):route.fallback());
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{models:["fixture-model"],metadata:{provider:runtime,models:[{id:"fixture-model",name:"Fixture Model",provider:runtime,agent:"Fixture"}]}}));
  await page.route(/\/api\/thread-meta(?:\?|$)/,route=>{const id=new URL(route.request().url()).searchParams.get("threadId")||route.request().postDataJSON?.()?.threadId;return json(route,meta[id]||{projectless:!project,environmentId:null})});
  await page.route(/\/api\/checkpoints(?:\?|$)/,route=>json(route,route.request().method()==="GET"?{checkpoints:[]}:{supported:false}));
  await page.route(/\/api\/projects$/,route=>json(route,{projects:project?[project]:[],...(project?{project}:{})}));
  await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
  await page.route(/\/api\/git\/info\?/,route=>json(route,project?{isGit:true,root:cwd,branch:project.branch||"main",branches:["main"],upstream:"origin/main",status:[],remotes:[],worktrees:[{path:cwd,branch:project.branch||"main"}]}:{isGit:false}));
  await page.route(/\/api\/context\/packet$/,route=>json(route,{id:"ctx",root:cwd,task:"",generatedAt:Date.now(),tokenEstimate:0,maxTokens:0,items:[],injection:"",skipped:true,budget:{mode:"exhausted",skip:true},stats:{}}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.addInitScript(value=>localStorage.setItem("trebell-layout-v1",JSON.stringify(value)),layout);
  await page.goto("/");
}
const threadRow=(page,name)=>page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});
async function openThread(page,name){const row=threadRow(page,name);await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);return row}
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const now=()=>Date.now()/1000;

test("an opened step keeps its details: a command's exit code, folder, duration and real command line, and a change's files and diffs",async({page})=>{
  test.setTimeout(45_000);
  const thread={id:"details-general",name:"Step details fixture",preview:"Notes",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Tidy my notes."}]},{type:"agentMessage",id:"assistant-1",text:"On it."}]}]};
  const harness=await startHarness([thread]);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:true,environmentId:null}},runtime:"cursor"});
    await openThread(page,thread.name);
    await expect(page.locator(".user-bubble").first()).toContainText("Tidy my notes.");
    const turnId="turn-2",started=Date.now();
    harness.push("turn/started",{threadId:thread.id,turn:{id:turnId,status:"inProgress",startedAt:now()}});
    const items=[
      {type:"commandExecution",id:"cmd-silent",command:"test -f missing.txt",cwd:"/work/notes",exitCode:1,durationMs:42,status:"failed",aggregatedOutput:""},
      {type:"commandExecution",id:"cmd-relay",command:"Run the unit tests",cwd:"",exitCode:3,durationMs:null,aggregatedOutput:"2 failing",rawInput:{command:"npm test -- --grep auth",description:"Run the unit tests"},status:"completed"},
      {type:"fileChange",id:"change-codex",status:"completed",changes:[
        {path:"notes/todo.md",kind:{type:"add"},diff:"remember the milk\n- and the bread\n"},
        {path:"notes/old-plan.md",kind:{type:"update",move_path:"notes/plan.md"},diff:"@@ -1,2 +1,2 @@\n-# Plan\n+# Plan for October\n keep the list short"},
      ]},
      {type:"fileChange",id:"change-relay",status:"completed",changes:[{path:"notes/ideas.md",kind:"update",oldText:"one\ntwo\nthree\n",newText:"one\n2\nthree\n"}]},
    ];
    for(const item of items){harness.push("item/started",{threadId:thread.id,turnId,item:{...item,status:"inProgress"},startedAtMs:started});harness.push("item/completed",{threadId:thread.id,turnId,item,completedAtMs:started+50})}
    harness.push("guardianWarning",{threadId:thread.id,message:"Auto review is unavailable for this turn"});
    harness.push("turn/completed",{threadId:thread.id,turn:{id:turnId,status:"completed",completedAt:now()}});
    const rows=page.locator(".agent-block .tool-event");
    const silent=rows.filter({hasText:"test -f missing.txt"}),relay=rows.filter({hasText:"Run the unit tests"});
    const codexChange=rows.filter({has:page.locator("summary",{hasText:"Editing files"})}).first(),relayChange=rows.filter({has:page.locator("summary",{hasText:"Editing files"})}).nth(1);
    await expect(rows.filter({hasText:"Auto review is unavailable for this turn"})).toHaveCount(1);
    for(const row of [silent,relay,codexChange,relayChange])await row.locator("summary").click();
    // A silent command that failed still says how: exit 1, where it ran and how long it took.
    await expect(silent.locator(".tool-event-facts>span")).toHaveText(["exit 1","/work/notes","42 ms"]);
    await expect(silent.locator(".tool-event-facts .fact-exit")).toHaveClass(/tone-err/);
    await expect(silent.locator(".tool-event-body>pre").first()).toHaveText("test -f missing.txt");
    // A relay command titled by what it does prints the line it ran, its output and its exit code.
    await expect(relay.locator(".tool-event-body>pre").first()).toHaveText("npm test -- --grep auth");
    await expect(relay.locator(".tool-event-body>pre").nth(1)).toHaveText("2 failing");
    await expect(relay.locator(".tool-event-facts>span")).toHaveText(["exit 3"]);
    // A change lists its files with what happened to each and the diff; a General chat has no Git diff, so no Inspect button.
    const codexFiles=codexChange.locator(".tool-event-change");
    await expect(codexFiles).toHaveCount(2);
    await expect(codexFiles.nth(0).locator(".tool-event-change-head")).toHaveText("notes/todo.mdadded");
    await expect(codexFiles.nth(0).locator(".tool-event-diff .diff-add")).toHaveText(["+remember the milk","+- and the bread"]);
    await expect(codexFiles.nth(1).locator(".tool-event-change-head")).toHaveText("notes/old-plan.mdmoved to notes/plan.md");
    await expect(codexFiles.nth(1).locator(".tool-event-diff>span")).toHaveText(["@@ -1,2 +1,2 @@","-# Plan","+# Plan for October"," keep the list short"]);
    await expect(codexFiles.nth(1).locator(".tool-event-diff .diff-del")).toHaveText("-# Plan");
    await expect(relayChange.locator(".tool-event-change-head")).toHaveText("notes/ideas.mdedited");
    await expect(relayChange.locator(".tool-event-diff>span")).toHaveText([" one","-two","+2"," three"]);
    await expect(page.getByRole("button",{name:"Inspect changes"})).toHaveCount(0);
    await expect(page.locator(".agent-block .tool-json")).toHaveCount(0);
    const colors=await codexFiles.nth(1).evaluate(node=>{const add=node.querySelector(".diff-add"),del=node.querySelector(".diff-del"),ctx=node.querySelector(".diff-ctx");return {add:getComputedStyle(add).color,del:getComputedStyle(del).color,ctx:getComputedStyle(ctx).color}});
    expect(new Set(Object.values(colors)).size).toBe(3);
    const bounds=await page.locator(".conversation-scroll").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
    await silent.scrollIntoViewIfNeeded();await settle(page);
    await page.screenshot({path:join(shotsDir,"activity-step-details-1280x800.png"),fullPage:true,animations:"disabled"});
    await relayChange.scrollIntoViewIfNeeded();await settle(page);
    await page.screenshot({path:join(shotsDir,"activity-step-changes-1280x800.png"),fullPage:true,animations:"disabled"});
    await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode","light");
    await silent.scrollIntoViewIfNeeded();await settle(page);
    await page.screenshot({path:join(shotsDir,"activity-step-details-light-1280x800.png"),fullPage:true,animations:"disabled"});
    await relayChange.scrollIntoViewIfNeeded();await settle(page);
    await page.screenshot({path:join(shotsDir,"activity-step-changes-light-1280x800.png"),fullPage:true,animations:"disabled"});
    // Once the turn ends nothing runs: the notice row and the failed command count as finished steps.
    await page.getByTestId("right-panel-toggle").click();
    await page.getByTestId("right-panel").locator(".context-panel-tab-scroll").getByRole("button",{name:"Runtime",exact:true}).click();
    await expect(page.getByTestId("runtime-activity-steps")).toHaveText(/^(\d+)\/\1 current activity steps complete$/);
    const [done,total]=(await page.getByTestId("runtime-activity-steps").textContent()).match(/\d+/g).map(Number);
    expect(done).toBe(total);expect(total).toBeGreaterThanOrEqual(5);
  }finally{await harness.close()}
});

test("Move up and Move down follow the sidebar's groups: General chats and project threads do not step over each other",async({page})=>{
  test.setTimeout(35_000);
  const base={cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[]};
  const threads=[{...base,id:"project-a",name:"Project thread A",preview:"A"},{...base,id:"general-chat",name:"General fixture chat",preview:"G"},{...base,id:"project-b",name:"Project thread B",preview:"B"}];
  const meta={"general-chat":{projectless:true,environmentId:null},"project-a":{projectless:false,environmentId:null},"project-b":{projectless:false,environmentId:null}};
  const harness=await startHarness(threads);
  try{
    await openApp(page,{harness,threads,meta});
    await expect(threadRow(page,"Project thread B")).toBeVisible();
    const groups=await page.locator(".thread-sections section").evaluateAll(sections=>sections.map(section=>[section.querySelector("h4").firstChild.textContent,[...section.querySelectorAll(".thread-main")].map(node=>node.title)]));
    expect(groups).toEqual([["General",["General fixture chat"]],["Active",["Project thread A","Project thread B"]]]);
    const menu=async name=>{const row=threadRow(page,name);await row.hover();await row.locator(".thread-menu summary").click();return row};
    // The lone General chat has nowhere to move; A is first of Active and B last, whatever the harness lists between them.
    const general=await menu("General fixture chat");
    await expect(general.getByRole("button",{name:"Move up",exact:true})).toBeDisabled();
    await expect(general.getByRole("button",{name:"Move down",exact:true})).toBeDisabled();
    await page.keyboard.press("Escape");
    const first=await menu("Project thread A");
    await expect(first.getByRole("button",{name:"Move up",exact:true})).toBeDisabled();
    await expect(first.getByRole("button",{name:"Move down",exact:true})).toBeEnabled();
    await page.screenshot({path:join(shotsDir,"sidebar-move-groups-1600x980.png"),animations:"disabled"});
    // Moving A down puts it after B, the next thread in its own group (not before B, which would leave the list as it was).
    await first.getByRole("button",{name:"Move down",exact:true}).click();
    await expect.poll(()=>harness.requests.filter(request=>request.method==="thread/section/move").map(request=>request.params)).toEqual([{threadId:"project-a",sectionId:null,beforeThreadId:null}]);
    const last=await menu("Project thread B");
    await expect(last.getByRole("button",{name:"Move up",exact:true})).toBeEnabled();
    await expect(last.getByRole("button",{name:"Move down",exact:true})).toBeDisabled();
    await last.getByRole("button",{name:"Move up",exact:true}).click();
    await expect.poll(()=>harness.requests.filter(request=>request.method==="thread/section/move").at(-1)?.params).toEqual({threadId:"project-b",sectionId:null,beforeThreadId:"project-a"});
  }finally{await harness.close()}
});

// A disabled menu item reads and hovers as unavailable: muted text, no hover highlight, the default cursor.
for(const theme of ["dark","light","custom"])test(`a disabled thread-menu item looks and hovers disabled in the ${theme} theme`,async({page})=>{
  test.setTimeout(30_000);
  const thread={id:"menu-only",name:"Only thread fixture",preview:"Only",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[]};
  const custom={id:"custom-shell-fixes-nord",name:"Nord fixture",appearance:"dark",canvas:"#2e3440",accent:"#88c0d0",colors:{}};
  const settings=theme==="light"?{appearanceMode:"light"}:theme==="custom"?{customThemes:[custom],appearance:custom.id}:{};
  const harness=await startHarness([thread]);
  try{
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:false,environmentId:null}},settings});
    if(theme==="custom")await expect(page.locator("html")).toHaveAttribute("data-custom-theme","true");
    if(theme==="light")await expect(page.locator("html")).toHaveAttribute("data-mode","light");
    const row=threadRow(page,thread.name);await row.hover();await row.locator(".thread-menu summary").click();
    const pin=row.getByRole("button",{name:"Pin",exact:true}),moveUp=row.getByRole("button",{name:"Move up",exact:true});
    await expect(moveUp).toBeDisabled();
    const style=locator=>locator.evaluate(node=>{const style=getComputedStyle(node);return {color:style.color,background:style.backgroundColor,cursor:style.cursor}});
    // The muted token as this button resolves it (an inline !important declaration outranks every theme rule).
    const muted=await moveUp.evaluate(node=>{node.style.setProperty("color","var(--tx3)","important");const color=getComputedStyle(node).color;node.style.removeProperty("color");return color});
    const enabledAtRest=await style(pin),disabledAtRest=await style(moveUp);
    await pin.hover();const enabledHover=await style(pin);
    await moveUp.hover();const disabledHover=await style(moveUp);
    await page.screenshot({path:join(shotsDir,`thread-menu-disabled-${theme}-1600x980.png`),animations:"disabled"});
    expect(disabledAtRest.color).toBe(muted);
    expect(disabledAtRest.color).not.toBe(enabledAtRest.color);
    expect(disabledHover).toEqual(disabledAtRest);
    expect(disabledAtRest.cursor).toBe("default");
    expect(enabledHover.background).not.toBe(enabledAtRest.background);
  }finally{await harness.close()}
});

test("typing in the composer does not re-render the thread sidebar",async({page})=>{
  test.setTimeout(30_000);
  // A DevTools-style hook sees each React commit: the sidebar's props object changes only when the sidebar re-renders (memo
  // keeps the previous one when it skips).
  await page.addInitScript(()=>{
    const stats={commits:0,sidebarRenders:0,changedKeys:[]};window.__sidebarStats=stats;let last=null;
    const findSidebar=root=>{const stack=[root];while(stack.length){const fiber=stack.pop();if(fiber.stateNode?.nodeType===1&&fiber.stateNode.matches("aside.sidebar"))return fiber;if(fiber.sibling)stack.push(fiber.sibling);if(fiber.child)stack.push(fiber.child)}return null};
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(renderer){const id=this.renderers.size+1;this.renderers.set(id,renderer);return id},onScheduleFiberRoot(){},onCommitFiberUnmount(){},onPostCommitFiberRoot(){},checkDCE(){},
      onCommitFiberRoot(_id,root){stats.commits++;const props=findSidebar(root.current)?.return?.memoizedProps;if(!props)return;if(last&&props!==last){stats.sidebarRenders++;stats.changedKeys.push(Object.keys(props).filter(key=>!Object.is(props[key],last[key])))}last=props}};
  });
  const thread={id:"render-thread",name:"Render count fixture",preview:"Render",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[]};
  const harness=await startHarness([thread]);
  try{
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:true,environmentId:null}}});
    await openThread(page,thread.name);
    const composer=page.getByTestId("composer");await composer.click();await settle(page);
    const before=await page.evaluate(()=>({...window.__sidebarStats}));
    expect(before.commits).toBeGreaterThan(0);
    await composer.pressSequentially("hello sidebar",{delay:15});await settle(page);
    const after=await page.evaluate(()=>({...window.__sidebarStats,changedKeys:window.__sidebarStats.changedKeys.slice(-5)}));
    // Thirteen keystrokes re-render App each time; the sidebar sits them out.
    expect(after.commits-before.commits).toBeGreaterThanOrEqual(13);
    expect({renders:after.sidebarRenders-before.sidebarRenders,keys:after.changedKeys}).toEqual({renders:0,keys:before.changedKeys.slice(-5)});
  }finally{await harness.close()}
});

for(const [width,height] of [[1280,800],[1600,980]])for(const mode of ["dark","light"])test(`the header names the open thread with the 520px inspector at ${width}x${height} in ${mode} mode`,async({page})=>{
  test.setTimeout(35_000);
  const project={id:"header-project",name:"Billing reconciliation service with a very long project name",path:process.cwd(),environmentId:null,branch:"feature/reconcile-refunds-in-the-ledger-export"};
  const thread={id:"header-thread",name:"Investigate why the nightly billing reconciliation job double counts refunds in the ledger export",preview:"Refunds",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Why are refunds counted twice?"}]},{type:"agentMessage",id:"assistant-1",text:"Looking."}]}]};
  const harness=await startHarness([thread]);
  try{
    await page.setViewportSize({width,height});
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:false,environmentId:null}},project,settings:{appearanceMode:mode},layout:{sidebarWidth:258,rightPanelWidth:520,terminalHeight:330}});
    await openThread(page,thread.name);
    await page.getByTestId("composer").fill("Keep going.");await page.getByTestId("send").click();
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toBeVisible();
    await page.getByTestId("right-panel-toggle").click();
    await expect(page.getByTestId("right-panel")).toBeVisible();await settle(page);
    expect(Math.round((await page.getByTestId("right-panel").boundingBox()).width)).toBe(520);
    const header=page.locator(".chat-workspace .workspace-header"),title=header.locator(".thread-title-button strong");
    await expect(title).toBeVisible();
    const titleWidth=(await title.boundingBox()).width;
    // At least the readable width (80px), and far more than the 56px the visual tour asks for.
    expect(titleWidth).toBeGreaterThanOrEqual(80);
    // The project crumb gave way first: never wider than the title it sits beside.
    expect((await header.locator(".project-crumb:not(.sidebar-reopen)").boundingBox()).width).toBeLessThan(titleWidth);
    for(const name of ["Review","Stop"])await expect(header.getByRole("button",{name,exact:true})).toBeVisible();
    await expect(header.locator(".branch-control")).toBeVisible();
    await expect(header.locator(".project-crumb:not(.sidebar-reopen)")).toHaveText(project.name);
    const metrics=await header.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await page.screenshot({path:join(shotsDir,`header-inspector-long-names-${mode}-${width}x${height}.png`),animations:"disabled"});
    // Closing the inspector gives the labels back.
    await page.getByTestId("right-panel-toggle").click();await settle(page);
    await expect(header).toHaveAttribute("data-fit","0");
    await expect(header.locator(".review-control")).toContainText("Review");
  }finally{await harness.close()}
});

test("a narrow browser window collapses the sidebar instead of scrolling sideways, and gets it back when it widens",async({page,request})=>{
  test.setTimeout(30_000);
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",environmentThemeSelections:{},panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
  const overflow=()=>page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
  await page.setViewportSize({width:700,height:800});
  await page.goto("/");
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
  let metrics=await overflow();expect(metrics.scroll).toBeLessThanOrEqual(metrics.client);
  expect((await page.getByTestId("composer").boundingBox()).width).toBeGreaterThan(500);
  await page.screenshot({path:join(shotsDir,"narrow-window-700x800.png"),animations:"disabled"});
  // Opened by hand it stays open, beside a narrower main column that still fits the window.
  await page.getByRole("button",{name:"Open sidebar"}).first().click();
  await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-collapsed/);
  metrics=await overflow();expect(metrics.scroll).toBeLessThanOrEqual(metrics.client);
  await page.screenshot({path:join(shotsDir,"narrow-window-sidebar-open-700x800.png"),animations:"disabled"});
  await page.getByRole("button",{name:"Collapse sidebar"}).click();
  await page.setViewportSize({width:1280,height:800});
  await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-collapsed/);
  // A sidebar the person collapsed at a wide size stays collapsed through a narrow and a wide window.
  await page.getByRole("button",{name:"Collapse sidebar"}).click();
  await page.setViewportSize({width:700,height:800});await settle(page);
  await page.setViewportSize({width:1280,height:800});await settle(page);
  await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
});
