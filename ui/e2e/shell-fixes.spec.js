import { test,expect } from "@playwright/test";
import { mkdirSync,writeFileSync } from "node:fs";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { titleWhole } from "../src/header-fit.js";

// The conversation's activity rows, the thread sidebar, the workspace header and the app shell at narrow widths, against a
// fake harness socket (as in reasoning-text.spec.js).
const shotsDir=process.env.TREBELL_E2E_SHOTS_DIR||fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(shotsDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The harness end of the agent socket: it lists the threads, starts the turns it is sent, records every request, and pushes
// what the test sends. respond(message) answers a request itself when it returns a result ({rpcError} answers with that error), or a
// promise of one (a slow answer).
async function startHarness(threads,{respond=()=>undefined}={}){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set(),requests=[];
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{sockets.add(ws);ws.on("close",()=>sockets.delete(ws));ws.on("message",async raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push({method:message.method,params:message.params});let result={};
    const thread=threads.find(item=>item.id===message.params?.threadId)||threads[0];let answer=respond(message);
    if(typeof answer?.then==="function")answer=await answer;
    if(answer!==undefined)result=answer;
    else if(message.method==="initialize")result={userAgent:"shell-fixes-fixture"};
    else if(message.method==="thread/list")result={data:threads.map(item=>({...item,turns:[]})),nextCursor:null};
    else if(message.method==="thread/resume")result=message.params?.excludeTurns?{thread:{...thread,turns:[]}}:{thread};
    else if(message.method==="turn/start")result={turn:{id:"turn-live",status:"inProgress",items:[]}};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(/\/list$/.test(message.method))result={data:[],nextCursor:null};
    if(ws.readyState===ws.OPEN)ws.send(JSON.stringify(result?.rpcError?{id:message.id,error:result.rpcError}:{id:message.id,result}));
  })});
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",requests,
    push(method,params){for(const ws of sockets)ws.send(JSON.stringify({method,params}))},
    async close(){for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))},
  };
}

async function openApp(page,{harness,threads,meta,project=null,runtime="codex",settings={},layout={sidebarWidth:258,rightPanelWidth:460,terminalHeight:330},cwd=process.cwd(),settingsFailure=()=>""}){
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  const appSettings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",...(project?{activeProjectId:project.id}:{}),...settings};
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd,platform:process.platform,version:"shell-fixes-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:appSettings,projects:project?[project]:[],threadMeta:meta}));
  // A saved setting is kept, as the server keeps it, so a reload reads it back; settingsFailure() names an error to fail a save with.
  await page.route(/\/api\/settings$/,route=>{
    if(route.request().method()!=="POST")return route.fallback();
    const failure=settingsFailure();if(failure)return route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:failure})});
    return json(route,Object.assign(appSettings,route.request().postDataJSON()||{}));
  });
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
  // A thread title as Chrome lays it out, for the header checks (window.__titleBox): its box (shown) and its text's whole width
  // (whole) in CSS pixels, the device pixels to a CSS pixel (zoom), and whether Chrome cut it (cut). A Range over a text the ellipsis
  // cuts gives two client rects, the text's whole fragment, which the ellipsis hides, and the part drawn before it, and one over a
  // text drawn whole (probes of boxes from 3px short of "Repo task one" to 1px over it, and from 0 to 4 layout units short at 100%,
  // 125% and 150% display scaling, found the two rects wherever its pixels showed the ellipsis against the title clipped, and only
  // there: UI fix lane r6x). So cut is what a person sees, a layout unit or two over the box, at any zoom, whatever the widths round
  // to. A box too narrow to draw even part of the text hides all of it, with one rect: a box a whole pixel or more short is cut. A test
  // whose device scale factor is only emulated, which lays the page out in CSS pixels, says so in window.__layoutZoom (1).
  await page.addInitScript(()=>{window.__titleBox=strong=>{const text=document.createRange();text.selectNodeContents(strong);const shown=strong.getBoundingClientRect().width,whole=text.getBoundingClientRect().width;return {shown,whole,zoom:window.__layoutZoom||devicePixelRatio,cut:text.getClientRects().length>1||whole-shown>=1}}});
  await page.goto("/");
}
// Whether the title's pixels show the ellipsis: the title drawn as it is against the same title clipped instead (text-overflow:
// clip draws its text whole and cuts it at the box's edge), which differ only where the ellipsis takes the place of its last
// letters. Neither the style nor the shots move the header, so it is not fitted again in between.
async function ellipsisDrawn(title){
  const shot=async overflow=>{await title.evaluate((node,overflow)=>{node.style.textOverflow=overflow},overflow);return (await title.screenshot({animations:"disabled"})).toString("base64")};
  try{return (await shot(""))!==(await shot("clip"))}finally{await title.evaluate(node=>{node.style.textOverflow=""})}
}
// How far a title's box falls short of its text, in layout units (64ths of a pixel of its layout): Chrome draws its ellipsis from two.
const unitsShort=box=>Math.round(box.whole*64*box.zoom)-Math.round(box.shown*64*box.zoom);
// The agent relay with its own thread store, as Trebell serves Trebell Native and the relay harnesses (Claude Code, OpenCode, Cursor,
// Grok, Antigravity): what a move leaves is what the relay keeps. A second start on the same home is a server restart.
async function startRelay(home,runtime="native"){
  const env={...process.env,TREBELL_HOME:home},threadStore=new AgentThreadStore(env),meta=new Map();
  const runtimeManager={instances:()=>[],activeInstance:()=>({id:runtime+"-default",kind:runtime}),activeRuntime:()=>runtime,probe:async()=>({available:false,message:"fixture runtime"})};
  const state={settings:()=>({activeEnvironmentId:null}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},threadUsage:()=>({totalTokens:0})};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"shell-fixes-relay"});
  const port=await freePort();await new Promise((resolve,reject)=>server.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {threadStore,wsUrl:"ws://127.0.0.1:"+port+"/api/agent/ws",async close(){await relay.close();await new Promise(resolve=>server.close(()=>resolve()))}};
}
// A Codex app-server's sections as the bundled one (0.155.1) keeps them, checked live in an isolated CODEX_HOME: each section has its
// own order (thread/section/move puts a thread before a thread in that section or at its end, and thread/list sorts a section by
// section_position, top first, only with a section filter); a move changes no thread's updatedAt; the threads outside a section have no
// order (a thread to go before is refused there); and a fresh home already has a Pinned section. thread/list gives one page of the
// newest threads, and thread/search finds threads by name, newest first, with no place in their section. listDelay() and moveDelay()
// slow the plain listing and each move by that many milliseconds (a busy app-server).
async function startCodexHarness(threads,sections,{failOrder=[],listDelay=()=>0,moveDelay=()=>0}={}){
  const order=new Map(sections.map(section=>[section.id,threads.filter(thread=>thread.section?.id===section.id).map(thread=>thread.id)]));
  const fail=message=>({rpcError:{code:-32600,message}}),later=(ms,answer)=>ms>0?new Promise(resolve=>setTimeout(()=>resolve(answer()),ms)):answer();
  return Object.assign(await startHarness(threads,{respond:message=>{
    const params=message.params||{};
    if(message.method==="threadSection/list")return {data:sections,nextCursor:null};
    if(message.method==="thread/list"){
      if(params.sortKey==="section_position"){
        if(params.sectionId==null)return fail("section-position sorting requires a section filter");
        if(failOrder.includes(params.sectionId))return fail("section order unavailable");
        return {data:(order.get(params.sectionId)||[]).map(id=>({...threads.find(thread=>thread.id===id),turns:[]})),nextCursor:null};
      }
      return later(listDelay(),()=>({data:[...threads].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,Number(params.limit)||100).map(thread=>({...thread,turns:[]})),nextCursor:null}));
    }
    if(message.method==="thread/search"){
      const term=String(params.searchTerm||"").toLowerCase();
      return {data:threads.filter(thread=>!thread.archived&&String(thread.name||"").toLowerCase().includes(term)).sort((a,b)=>b.updatedAt-a.updatedAt).map(thread=>({thread:{...thread,turns:[]},snippet:thread.name})),nextCursor:null};
    }
    if(message.method==="thread/section/move")return later(moveDelay(),()=>{
      const thread=threads.find(item=>item.id===params.threadId),sectionId=params.sectionId??null,before=params.beforeThreadId??null;
      if(before&&!sectionId)return fail("beforeThreadId requires a non-null sectionId");
      const members=sectionId?(order.get(sectionId)||[]).filter(id=>id!==thread.id):[];
      if(before&&!members.includes(before))return fail(`before thread ${before} is not in section ${sectionId}`);
      for(const [id,ids] of order)order.set(id,ids.filter(item=>item!==thread.id));
      if(sectionId){members.splice(before?members.indexOf(before):members.length,0,thread.id);order.set(sectionId,members)}
      if((thread.section?.id??null)!==sectionId){thread.section=sectionId?sections.find(section=>section.id===sectionId):null;thread.sectionEnteredAt=sectionId?now():null}
      return {};
    });
    return undefined;
  }}),{order});
}
const sidebarGroups=page=>page.locator(".thread-sections section").evaluateAll(sections=>sections.map(section=>[section.querySelector("h4").firstChild.textContent,[...section.querySelectorAll(".thread-main")].map(node=>node.title)]));
const threadRow=(page,name)=>page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});
// The row is selected at the click; the thread is open once the composer no longer says it is opening.
async function openThread(page,name){const row=threadRow(page,name);await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);await expect(page.getByTestId("composer")).not.toHaveAttribute("placeholder","Opening thread…");return row}
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const now=()=>Date.now()/1000;

test("an opened step keeps its details: a command's exit code, folder, duration and real command line, and a change's files and diffs",async({page})=>{
  test.setTimeout(45_000);
  const thread={id:"details-general",name:"Step details fixture",preview:"Notes",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Tidy my notes."}]},{type:"agentMessage",id:"assistant-1",text:"On it."}]}]};
  const harness=await startHarness([thread]);
  try{
    // The turn's verification plan has checks still to run: that row stays incomplete after the turn ends.
    await page.route(/\/api\/verification\/plan-turn$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({supported:true,record:{id:"plan-1",turnId:"turn-2",risk:"medium",status:"planned",assessment:{status:"planned",summary:{required:2,passed:0}}},nextAction:{action:"run_check",nextStep:{id:"unit-tests"}},changedPaths:["notes/todo.md"]})}));
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:true,environmentId:null}},runtime:"cursor"});
    await openThread(page,thread.name);
    await expect(page.locator(".user-bubble").first()).toContainText("Tidy my notes.");
    const turnId="turn-2",started=Date.now();
    harness.push("turn/started",{threadId:thread.id,turn:{id:turnId,status:"inProgress",startedAt:now()}});
    const items=[
      {type:"commandExecution",id:"cmd-silent",command:"test -f missing.txt",cwd:"/work/notes",exitCode:1,durationMs:42,status:"failed",aggregatedOutput:""},
      // A relay harness reports every finished tool call completed, whatever the command's exit code.
      {type:"commandExecution",id:"cmd-relay",command:"Run the unit tests",cwd:"",exitCode:3,durationMs:null,aggregatedOutput:"2 failing",rawInput:{command:"npm test -- --grep auth",description:"Run the unit tests"},status:"completed"},
      {type:"commandExecution",id:"cmd-ok",command:"git status --short",cwd:"/work/notes",exitCode:0,durationMs:1250,status:"completed",aggregatedOutput:" M notes/todo.md"},
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
    // A relay command titled by what it does prints the line it ran, its output and its exit code; exit 3 is a failure, so the
    // row says failed (as Codex does for such a command), not done above a red exit code.
    await expect(relay.locator(".tool-event-body>pre").first()).toHaveText("npm test -- --grep auth");
    await expect(relay.locator(".tool-event-body>pre").nth(1)).toHaveText("2 failing");
    await expect(relay.locator(".tool-event-facts>span")).toHaveText(["exit 3"]);
    await expect(relay.locator("summary em")).toHaveText("failed");
    await expect(relay).toHaveClass(/status-error/);
    const ok=rows.filter({hasText:"git status --short"});
    await expect(ok.locator("summary em")).toHaveText("done");
    await expect(ok).not.toHaveClass(/status-error/);
    // A change lists its files with what happened to each and the diff; a General chat has no Git diff, so no Inspect button.
    const codexFiles=codexChange.locator(".tool-event-change");
    await expect(codexFiles).toHaveCount(2);
    await expect(codexFiles.nth(0).locator(".tool-event-change-head")).toHaveText("notes/todo.mdadded");
    await expect(codexFiles.nth(0).locator(".tool-event-diff .diff-add")).toHaveText(["+remember the milk","+- and the bread"]);
    await expect(codexFiles.nth(1).locator(".tool-event-change-head .change-kind")).toHaveText("moved");
    await expect(codexFiles.nth(1).locator(".tool-event-change-head :is(code,.change-move-to)")).toHaveText(["notes/old-plan.md","to","notes/plan.md"]);
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
    // Once the turn ends nothing runs: the notice row and the failed commands count as finished steps, while the planned
    // verification, whose checks have not run, does not.
    const planned=rows.filter({hasText:"Verification planned"});
    await expect(planned.locator("summary em")).toHaveText("incomplete");
    await page.getByTestId("right-panel-toggle").click();
    await page.getByTestId("right-panel").locator(".context-panel-tab-scroll").getByRole("button",{name:"Runtime",exact:true}).click();
    await expect(page.getByTestId("runtime-activity-steps")).toHaveText(/^\d+\/\d+ current activity steps complete$/);
    const [done,total]=(await page.getByTestId("runtime-activity-steps").textContent()).match(/\d+/g).map(Number);
    // The count agrees with the timeline: every row but the planned verification shows an outcome.
    const pills=await rows.locator("summary em").allTextContents();
    expect(pills.filter(text=>!["done","failed","declined","error","warning"].includes(text))).toEqual(["incomplete"]);
    expect(total).toBe(pills.length);expect(total).toBeGreaterThanOrEqual(7);expect(done).toBe(total-1);
  }finally{await harness.close()}
});

// Long paths in a narrow column: each file keeps what happened to it whole while its path gives way, and a command's facts stay
// on one line however long the folder it ran in.
for(const [width,height,inspector,mode] of [[1280,800,true,"dark"],[1280,800,true,"light"],[1600,980,false,"dark"]])test(`long paths keep a change's kinds whole and a command's facts on one line at ${width}x${height}${inspector?" with the inspector":""} in ${mode} mode`,async({page})=>{
  test.setTimeout(40_000);
  const thread={id:"heads-thread",name:"Change heads fixture",preview:"Heads",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Fix the refund export."}]},{type:"agentMessage",id:"assistant-1",text:"On it."}]}]};
  const harness=await startHarness([thread]);
  try{
    await page.setViewportSize({width,height});
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:true,environmentId:null}},settings:{appearanceMode:mode}});
    await openThread(page,thread.name);
    const turnId="turn-2",deep="services/billing/reconciliation/src/ledger/export/adapters/";
    harness.push("turn/started",{threadId:thread.id,turn:{id:turnId,status:"inProgress",startedAt:now()}});
    const command={type:"commandExecution",id:"cmd-worktree",command:"pnpm test --filter billing",cwd:"C:/Users/someone/.trebell/worktrees/billing-reconciliation-service/feature-reconcile-refunds",exitCode:0,durationMs:8300,status:"completed",aggregatedOutput:"ok"};
    const change={type:"fileChange",id:"change-heads",status:"completed",changes:[
      {path:deep+"refund-ledger-export-adapter.ts",kind:{type:"update",move_path:null},diff:"@@ -1 +1 @@\n-a\n+b"},
      {path:deep+"legacy-refund-ledger-export-adapter.ts",kind:{type:"delete"},diff:"old line"},
      {path:deep+"refund-adapter.ts",kind:{type:"update",move_path:deep+"refunds/refund-ledger-adapter.ts"},diff:"@@ -1 +1 @@\n-x\n+y"},
      {path:"README.md",kind:{type:"add"},diff:"hello"},
    ]};
    for(const item of [command,change]){harness.push("item/started",{threadId:thread.id,turnId,item:{...item,status:"inProgress"}});harness.push("item/completed",{threadId:thread.id,turnId,item})}
    harness.push("turn/completed",{threadId:thread.id,turn:{id:turnId,status:"completed",completedAt:now()}});
    const rows=page.locator(".agent-block .tool-event");
    const changeRow=rows.filter({has:page.locator("summary",{hasText:"Editing files"})}),commandRow=rows.filter({hasText:"pnpm test --filter billing"});
    await changeRow.locator("summary").click();await commandRow.locator("summary").click();
    if(inspector){await page.getByTestId("right-panel-toggle").click();await expect(page.getByTestId("right-panel")).toBeVisible()}
    await settle(page);
    const fits=locator=>locator.evaluateAll(nodes=>nodes.map(node=>({text:node.textContent,whole:node.scrollWidth<=node.clientWidth+1})));
    // Every kind pill shows its whole word; the long paths are the ones cut, and only in their own boxes.
    expect(await fits(changeRow.locator(".change-kind"))).toEqual(["edited","deleted","moved","added"].map(text=>({text,whole:true})));
    expect(await fits(changeRow.locator(".change-move-to"))).toEqual([{text:"to",whole:true}]);
    const paths=await fits(changeRow.locator(".tool-event-change-head code"));
    expect(paths.map(path=>path.text)).toEqual([deep+"refund-ledger-export-adapter.ts",deep+"legacy-refund-ledger-export-adapter.ts",deep+"refund-adapter.ts",deep+"refunds/refund-ledger-adapter.ts","README.md"]);
    expect(paths.at(-1).whole).toBe(true);
    for(const head of await changeRow.locator(".tool-event-change-head").all()){const box=await head.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(box.scroll).toBeLessThanOrEqual(box.client+1)}
    // A cut path keeps its end in view (the file name), with the ellipsis in front: the visible text ends where the box ends.
    const pathEnds=await changeRow.locator(".tool-event-change-head code").evaluateAll(nodes=>nodes.map(node=>{const range=document.createRange();range.selectNodeContents(node);const text=range.getBoundingClientRect(),box=node.getBoundingClientRect();return Math.abs(text.right-box.right)<=2||text.width<=box.width+1}));
    expect(pathEnds).toEqual([true,true,true,true,true]);
    // The facts are one line: exit code and duration whole, the folder cut at its start.
    const facts=await commandRow.locator(".tool-event-facts").evaluate(node=>{const spans=[...node.querySelectorAll(":scope>span")];return {tops:[...new Set(spans.map(span=>Math.round(span.getBoundingClientRect().top)))].length,height:Math.round(node.getBoundingClientRect().height),spans:spans.map(span=>({text:span.textContent,whole:span.scrollWidth<=span.clientWidth+1}))}});
    expect(facts.tops).toBe(1);expect(facts.height).toBeLessThanOrEqual(18);
    expect(facts.spans.map(span=>span.text)).toEqual(["exit 0",command.cwd,"8.3 s"]);
    expect(facts.spans[0].whole&&facts.spans[2].whole).toBe(true);
    await expect(commandRow.locator(".tool-event-facts .fact-cwd")).toHaveAttribute("title","Ran in "+command.cwd);
    const bounds=await page.locator(".conversation-scroll").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
    await commandRow.scrollIntoViewIfNeeded();await settle(page);
    await commandRow.locator(".tool-event-body").screenshot({path:join(shotsDir,`activity-step-facts-${mode}-${width}x${height}.png`),animations:"disabled"});
    await changeRow.locator(".tool-event-changes").screenshot({path:join(shotsDir,`activity-step-change-heads-${mode}-${width}x${height}.png`),animations:"disabled"});
  }finally{await harness.close()}
});

test("a turn's workspace diff is capped like a change's, and stays capped as it updates",async({page})=>{
  test.setTimeout(40_000);
  const thread={id:"turn-diff-thread",name:"Turn diff fixture",preview:"Deps",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Update the dependencies."}]},{type:"agentMessage",id:"assistant-1",text:"Updating."}]}]};
  const harness=await startHarness([thread]);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:true,environmentId:null}}});
    await openThread(page,thread.name);
    const turnId="turn-2",added=5000;
    // A lockfile rewrite: four header lines and thousands of added ones.
    const diff="diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,1 +1,"+added+" @@\n"+Array.from({length:added},(_,index)=>`+    "node_modules/pkg-${index}": {"version": "1.0.${index}"},`).join("\n");
    harness.push("turn/started",{threadId:thread.id,turn:{id:turnId,status:"inProgress",startedAt:now()}});
    harness.push("turn/diff/updated",{threadId:thread.id,turnId,diff});
    const turnRow=page.locator(".agent-block .tool-event").filter({has:page.locator("summary",{hasText:"Workspace diff updated"})});
    await expect(turnRow).toHaveCount(1);
    await turnRow.locator("summary").click();
    const lines=turnRow.locator(".tool-event-diff>span");
    await expect(lines).toHaveCount(401);
    await expect(lines.nth(3)).toHaveText("@@ -1,1 +1,5000 @@");
    await expect(lines.last()).toHaveText("… 4,604 more lines");
    // A later update while the row is open re-renders the same capped view, with the new count.
    harness.push("turn/diff/updated",{threadId:thread.id,turnId,diff:diff+"\n+  \"extra\": 1"});
    await expect(lines.last()).toHaveText("… 4,605 more lines");
    await expect(lines).toHaveCount(401);
    // A General chat has no Git diff to send the person to.
    await expect(turnRow.getByRole("button",{name:"Inspect changes"})).toHaveCount(0);
    await turnRow.locator(".tool-event-diff").evaluate(node=>{node.scrollTop=node.scrollHeight});
    await turnRow.scrollIntoViewIfNeeded();await settle(page);
    await page.screenshot({path:join(shotsDir,"activity-turn-diff-capped-1280x800.png"),animations:"disabled"});
  }finally{await harness.close()}
});

test("in a project with Git a capped turn diff offers the whole diff in the Diff tab",async({page})=>{
  test.setTimeout(35_000);
  const project={id:"diff-project",name:"Shop",path:process.cwd(),environmentId:null,branch:"main"};
  const thread={id:"turn-diff-git",name:"Turn diff Git fixture",preview:"Deps",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Update the dependencies."}]},{type:"agentMessage",id:"assistant-1",text:"Updating."}]}]};
  const harness=await startHarness([thread]);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:false,environmentId:null}},project});
    await openThread(page,thread.name);
    const diff="@@ -1 +1,600 @@\n"+Array.from({length:600},(_,index)=>"+line "+index).join("\n");
    harness.push("turn/started",{threadId:thread.id,turn:{id:"turn-2",status:"inProgress",startedAt:now()}});
    harness.push("turn/diff/updated",{threadId:thread.id,turnId:"turn-2",diff});
    const turnRow=page.locator(".agent-block .tool-event").filter({has:page.locator("summary",{hasText:"Workspace diff updated"})});
    await turnRow.locator("summary").click();
    await expect(turnRow.locator(".tool-event-diff>span").last()).toHaveText("… 201 more lines");
    await turnRow.getByRole("button",{name:"Inspect changes"}).click();
    await expect(page.getByTestId("right-panel").locator(".context-panel-tab.active")).toHaveAccessibleName("Diff");
  }finally{await harness.close()}
});

test("Move up and Move down follow the sidebar's groups: General chats and project threads do not step over each other",async({page})=>{
  test.setTimeout(35_000);
  // A relay harness (Claude Code here) lists each thread with its place among the threads outside a section.
  const base={cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[]};
  const threads=[{...base,id:"project-a",name:"Project thread A",preview:"A",sectionRank:0},{...base,id:"general-chat",name:"General fixture chat",preview:"G",sectionRank:1},{...base,id:"project-b",name:"Project thread B",preview:"B",sectionRank:2}];
  const meta={"general-chat":{projectless:true,environmentId:null},"project-a":{projectless:false,environmentId:null},"project-b":{projectless:false,environmentId:null}};
  const harness=await startHarness(threads);
  try{
    await openApp(page,{harness,threads,meta,runtime:"claude"});
    await expect(threadRow(page,"Project thread B")).toBeVisible();
    const groups=await page.locator(".thread-sections section").evaluateAll(sections=>sections.map(section=>[section.querySelector("h4").firstChild.textContent,[...section.querySelectorAll(".thread-main")].map(node=>node.title)]));
    expect(groups).toEqual([["General",["General fixture chat"]],["Active",["Project thread A","Project thread B"]]]);
    const menu=async name=>{const row=threadRow(page,name);await row.hover();await row.locator(".thread-menu summary").click();return row};
    // The lone General chat has nowhere to move; A is first of Active and B last, whatever the harness lists between them.
    const general=await menu("General fixture chat");
    await expect(general.getByRole("button",{name:"Move up",exact:true})).toBeDisabled();
    await expect(general.getByRole("button",{name:"Move down",exact:true})).toBeDisabled();
    // Closed by its own button: an Escape sent before the menu's key listener is set up (an effect after the toggle) is missed.
    await general.locator(".thread-menu summary").click();await expect(general.locator(".thread-menu")).not.toHaveAttribute("open","");
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

test("typing in the composer renders App once a key and does not re-render the thread sidebar",async({page})=>{
  test.setTimeout(30_000);
  // A DevTools-style hook sees each React commit: the sidebar's props object changes only when the sidebar re-renders (memo
  // keeps the previous one when it skips). App ran in a commit when its list of hooks is a new one (React builds it again on each
  // call of App), and it ran for nothing when React then threw away what it returned (no PerformedWork flag, 1): a set state to
  // the value the state holds, made once React has rendered App, still calls the whole of App again before React finds nothing
  // changed.
  await page.addInitScript(()=>{
    const stats={commits:0,sidebarRenders:0,changedKeys:[],appRenders:0,appWasted:0};window.__sidebarStats=stats;let last=null,appHooks=null;
    const findSidebar=root=>{const stack=[root];while(stack.length){const fiber=stack.pop();if(fiber.stateNode?.nodeType===1&&fiber.stateNode.matches("aside.sidebar"))return fiber;if(fiber.sibling)stack.push(fiber.sibling);if(fiber.child)stack.push(fiber.child)}return null};
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(renderer){const id=this.renderers.size+1;this.renderers.set(id,renderer);return id},onScheduleFiberRoot(){},onCommitFiberUnmount(){},onPostCommitFiberRoot(){},checkDCE(){},
      onCommitFiberRoot(_id,root){stats.commits++;
        // App is the first function component under the root (in StrictMode, main.jsx).
        let app=root.current.child;while(app&&app.tag!==0)app=app.child;
        if(app){if(appHooks&&app.memoizedState!==appHooks){stats.appRenders++;if(!(app.flags&1))stats.appWasted++}appHooks=app.memoizedState}
        const props=findSidebar(root.current)?.return?.memoizedProps;if(!props)return;if(last&&props!==last){stats.sidebarRenders++;stats.changedKeys.push(Object.keys(props).filter(key=>!Object.is(props[key],last[key])))}last=props}};
  });
  const thread={id:"render-thread",name:"Render count fixture",preview:"Render",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[]};
  const harness=await startHarness([thread]);
  try{
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:true,environmentId:null}}});
    await openThread(page,thread.name);
    const composer=page.getByTestId("composer");await composer.click();await settle(page);
    // The first key goes before the count: it also takes what a git poll before it left queued (below).
    const typedAt=Date.now();await composer.press("h");await expect(composer).toHaveValue("h");await settle(page);
    const before=await page.evaluate(()=>({...window.__sidebarStats}));
    expect(before.commits).toBeGreaterThan(0);
    await composer.pressSequentially("ello sidebar",{delay:15});await expect(composer).toHaveValue("hello sidebar");await settle(page);
    const typingMs=Date.now()-typedAt,after=await page.evaluate(()=>({...window.__sidebarStats,changedKeys:window.__sidebarStats.changedKeys.slice(-5)}));
    const app={renders:after.appRenders-before.appRenders,wasted:after.appWasted-before.appWasted};
    console.log("App renders for the 12 keys after the first:",JSON.stringify({...app,typingMs}));
    // Twelve keystrokes re-render App once each, none thrown away: the menu dismissal App keeps for the composer is cleared only
    // where there is one, as a reset of null over null after each key called the whole of App a second time. The git poll
    // (focus-poll.js, every 3.5 s while the window has focus) sets this projectless thread's null gitInfo to null, and React renders
    // App for that too, drawing nothing, at once or after the next key's render, which leaves it queued for its own lane: one for
    // each poll in the typing. The sidebar sits them out.
    expect(after.commits-before.commits).toBeGreaterThanOrEqual(12);
    expect(app.renders-app.wasted,`App's renders that drew the 12 keys (${JSON.stringify(app)})`).toBe(12);
    expect(app.wasted,`App's renders thrown away while the 12 keys were typed, ${typingMs} ms from the first key: at most one a git poll (${JSON.stringify(app)})`).toBeLessThanOrEqual(1+Math.floor(typingMs/3500));
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

// Linked pull requests give way too: several fold into the first one's chip (#12345 +1, as the sidebar row reads), then the chip
// keeps only its icon and count, before the title is squeezed under a readable width.
for(const [prCount,mode] of [[1,"dark"],[2,"dark"],[2,"light"],[3,"dark"]])test(`the header keeps the thread title readable beside ${prCount} linked pull request${prCount>1?"s":""} with the 520px inspector at 1280x800 in ${mode} mode`,async({page})=>{
  test.setTimeout(35_000);
  const project={id:"header-project",name:"Billing reconciliation service with a very long project name",path:process.cwd(),environmentId:null,branch:"feature/reconcile-refunds-in-the-ledger-export"};
  const thread={id:"header-thread",name:"Investigate why the nightly billing reconciliation job double counts refunds in the ledger export",preview:"Refunds",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Why are refunds counted twice?"}]},{type:"agentMessage",id:"assistant-1",text:"Looking."}]}]};
  const prs=Array.from({length:prCount},(_,index)=>({url:"https://github.com/acme/billing/pull/"+(12345+index),number:12345+index,title:"Refund fix "+index,state:"open"}));
  const harness=await startHarness([thread]);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:false,environmentId:null,linkedPullRequests:prs}},project,settings:{appearanceMode:mode},layout:{sidebarWidth:258,rightPanelWidth:520,terminalHeight:330}});
    await openThread(page,thread.name);
    const header=page.locator(".chat-workspace .workspace-header"),title=header.locator(".thread-title-button strong"),chips=header.locator(".header-pr");
    await expect(chips).toHaveCount(prCount);
    // Wide, every chip names its pull request.
    for(const [index,pr] of prs.entries())await expect(chips.nth(index)).toBeVisible();
    expect(await chips.evaluateAll(nodes=>nodes.map(node=>node.innerText.trim()))).toEqual(prs.map(pr=>"#"+pr.number));
    await page.getByTestId("composer").fill("Keep going.");await page.getByTestId("send").click();
    await expect(header.getByRole("button",{name:"Stop",exact:true})).toBeVisible();
    for(const phase of ["running","idle"]){
      if(phase==="idle"){harness.push("turn/completed",{threadId:thread.id,turn:{id:"turn-live",status:"completed",completedAt:now()}});await expect(header.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0)}
      if(!(await page.getByTestId("right-panel").isVisible())){await page.getByTestId("right-panel-toggle").click();await expect(page.getByTestId("right-panel")).toBeVisible()}
      await settle(page);
      await expect(title).toBeVisible();
      expect((await title.boundingBox()).width).toBeGreaterThanOrEqual(80);
      const metrics=await header.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
      // The first chip is always there, named and labelled with every linked pull request; the others fold into it.
      const first=chips.first();
      await expect(first).toBeVisible();
      await expect(first).toHaveAccessibleName("Pull request #12345");
      await expect(first).toHaveAttribute("title",prCount>1?"Open pull request #12345 · also linked: "+prs.slice(1).map(pr=>"#"+pr.number).join(", "):"Open pull request #12345");
      const shown=await chips.evaluateAll(nodes=>nodes.filter(node=>node.offsetParent).map(node=>node.innerText.replace(/\s+/g,"")));
      const fit=Number(await header.getAttribute("data-fit"));
      expect(shown).toEqual(prCount===1?[fit>=5?"":"#12345"]:fit>=5?[String(prCount)]:fit>=2?["#12345+"+(prCount-1)]:prs.map(pr=>"#"+pr.number));
      await page.screenshot({path:join(shotsDir,`header-linked-prs-${prCount}-${phase}-${mode}-1280x800.png`),animations:"disabled"});
    }
    // Closing the inspector gives every chip its number back.
    await page.getByTestId("right-panel-toggle").click();await settle(page);
    await expect(header).toHaveAttribute("data-fit","0");
    expect(await chips.evaluateAll(nodes=>nodes.map(node=>node.innerText.trim()))).toEqual(prs.map(pr=>"#"+pr.number));
  }finally{await harness.close()}
});

// Two linked pull requests fold into the first one's chip ("#101 +1") beside the open inspector, and the project crumb keeps a
// shortened name, ended by its ellipsis, wherever the room left beside the title holds it (UI lane D, 2026-10-17: the fold took the
// crumb's name too, leaving its folder icon while the title showed whole). At 1280 the title is whole only once the crumb keeps its
// icon alone (level 2 left the 85px "Repo task one" 80px, "Repo task …" as "Repo task two" reads: UI lane D, 2026-10-20), and the
// crumb's name there would be level 2 again, so the theme and palette buttons step aside into More actions for the crumb's name; at
// 1240 they step aside for the title, and the More actions button that holds them leaves the crumb's name no room beside it (before
// it showed there, the header had no theme or palette button and no More actions: UI lane C, 2026-10-21). The crumb keeps only its
// icon where its shortened name would cut the title: short of whole where the level shows it whole (at 1176 the name would leave
// it 83px of its 85), or under its readable width where the level leaves it cut. Beside a shortened crumb the title shows whole
// while the crumb can shrink further. The crumb's tooltip gives the whole name at each width.
for(const mode of ["dark","light"])test(`the project crumb keeps a shortened name beside two linked pull requests, at 1280 where they fold into one chip and the theme and palette buttons step aside into More actions for it, at 900 and 700, and keeps only its icon where its name would cut the title, in ${mode} mode`,async({page})=>{
  test.setTimeout(60_000);
  const project={id:"header-project",name:"Lane D Repository",path:process.cwd(),environmentId:null,branch:"main"};
  const thread={id:"header-thread",name:"Repo task one",preview:"Repo",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Look at repo task one"}]},{type:"agentMessage",id:"assistant-1",text:"Looked at repo task one."}]}]};
  const prs=[101,102].map(number=>({url:"https://github.com/lane-d/scratch/pull/"+number,number,title:"Scratch PR "+number,state:"open"}));
  const harness=await startHarness([thread]);
  try{
    // The Git tab syncs the thread's links with the server, which keeps these two.
    await page.route(/\/api\/source-control\/thread-link$/,route=>route.request().method()==="POST"?route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({links:prs})}):route.fallback());
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:false,environmentId:null,linkedPullRequests:prs}},project,settings:{appearanceMode:mode}});
    await openThread(page,thread.name);
    const right=page.getByTestId("right-panel");
    if(!(await right.isVisible())){await page.getByTestId("right-panel-toggle").click();await expect(right).toBeVisible()}
    await right.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
    await expect(right.locator(".linked-pr-panel h3")).toHaveText("Linked pull requests 2");
    const header=page.locator(".chat-workspace .workspace-header"),crumb=header.locator(".project-crumb:not(.sidebar-reopen)");
    // The name's box, and the width its first letter and the ellipsis take in its font: the least a shortened name shows.
    const name=()=>crumb.locator("span").evaluate(node=>{
      const style=getComputedStyle(node),least=document.createElement("span");
      least.style.cssText="position:absolute;visibility:hidden;white-space:nowrap";least.textContent=node.textContent.trim().charAt(0)+"…";
      for(const key of ["fontFamily","fontSize","fontWeight","fontStyle","fontStretch","fontFeatureSettings","fontVariationSettings","letterSpacing"])least.style[key]=style[key];
      document.body.append(least);const width=least.getBoundingClientRect().width;least.remove();
      return {display:style.display,shown:node.clientWidth,whole:node.scrollWidth,least:width,overflow:style.textOverflow};
    });
    // The main column beside the docked 460px inspector at 1280, 1240, 1180 and 1176, and beside the 224px sidebar at 1100; at 900
    // and below the inspector lies over it, and at 700 the sidebar has closed. At 1280 and 1240 the theme and palette buttons have
    // stepped aside into More actions, and at 1240, 1180, 1176 and 1100 the crumb has its shortened name or the title needs the room.
    for(const [width,column,named] of [[1280,562,true],[900,704,true],[700,700,true],[1240,522,false],[1180,462,false],[1176,458,false],[1100,416,false]]){
      await page.setViewportSize({width,height:800});
      await expect.poll(()=>header.evaluate(node=>Math.round(node.getBoundingClientRect().width))).toBe(column);await settle(page);
      const chips=await header.locator(".header-pr").evaluateAll(nodes=>nodes.filter(node=>node.offsetParent).map(node=>node.innerText.replace(/\s+/g,"")));
      if(width===1280)expect(chips,"the pull requests fold into the first one's chip").toEqual(["#101+1"]);
      if(width===1280||width===1240){
        await expect(header.getByRole("button",{name:"Command palette",exact:true}),"the palette button has stepped aside").toBeHidden();
        await expect(header.getByRole("button",{name:"More actions",exact:true}),"More actions holds the theme and palette buttons").toBeVisible();
      }
      const shown=await name();
      // The crumb's box and its least width, and the title's box and the width its text takes, to the fraction of a pixel, and
      // whether Chrome cut the title with its ellipsis.
      const squeeze=await header.evaluate(node=>{
        const box=node.querySelector(".project-crumb:not(.sidebar-reopen)");
        return {crumb:box.getBoundingClientRect().width,least:parseFloat(getComputedStyle(box).minWidth),title:window.__titleBox(node.querySelector(".thread-title-button strong"))};
      }),titleBox=squeeze.title;
      console.log(`header at ${width}: fit ${await header.getAttribute("data-fit")}, crumb ${squeeze.crumb.toFixed(3)}px (least ${squeeze.least.toFixed(3)}), its name ${shown.display==="none"?"hidden":shown.shown+" of "+shown.whole+"px"}, title ${titleBox.shown.toFixed(3)}px for its text's ${titleBox.whole.toFixed(3)}px${titleBox.cut?", cut":""}, chips ${chips.join(" ")}`);
      // The crumb gives way before the title: beside a crumb wider than its least width the title is not cut at all (it took a
      // few hundredths of a pixel of the crumb's squeeze, and its ellipsis showed in place of its last letters).
      if(squeeze.crumb>squeeze.least+0.5)expect.soft(titleBox.cut,`the title beside a crumb wider than its least width shows whole, with no ellipsis, at ${width}px`).toBe(false);
      if(named||shown.display!=="none"){
        expect(shown.display,`the crumb's name at ${width}px`).not.toBe("none");
        expect(shown.shown+1,`the crumb's name shows its first letter and the ellipsis at least at ${width}px`).toBeGreaterThanOrEqual(shown.least);
        if(shown.shown<shown.whole)expect(shown.overflow,`the crumb's name is cut with an ellipsis at ${width}px`).toBe("ellipsis");
      }else{
        // Its icon alone, only because its shortened name (the header's data-crumb) would cut the title: put its ellipsis on it, where
        // the level shows the title whole, or leave it under its readable width where the level leaves it cut (this was held to the
        // readable width either way, so at 1176, where the name would leave the title 83px of its 85, the header was right and the
        // check failed).
        const withName=await header.evaluate(node=>{node.dataset.crumb="short";const box=window.__titleBox(node.querySelector(".thread-title-button strong"));delete node.dataset.crumb;return box});
        if(!titleBox.cut)expect(withName.cut,`the crumb's shortened name would cut the title at ${width}px (${withName.shown.toFixed(3)}px for ${withName.whole.toFixed(3)}px)`).toBe(true);
        else expect(withName.shown+1,`the title beside the crumb's shortened name at ${width}px`).toBeLessThan(Math.min(withName.whole,80));
      }
      // The 85px title shows whole at each width: a level that folds no action gives it that (it read 80px of itself at 1280 and 82px
      // at 1180, the levels after them not tried), or at 1176 the first fold, which adds no button. There the More actions button
      // that holds the theme and palette buttons leaves it 82px at level 5, the last that folds nothing, and the header stopped there,
      // "Repo task o…", while at 1100 it folded an action and showed it whole.
      expect(titleBox.cut,`the title shows whole, with no ellipsis, at ${width}px (${titleBox.shown.toFixed(3)}px for its text's ${titleBox.whole.toFixed(3)}px)`).toBe(false);
      const metrics=await header.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
      await expect(crumb).toHaveAttribute("title",project.name+" · Projects and workspaces");
      // Beside the docked inspector the pointer reaches the crumb; below 900px the inspector's scrim lies over the header.
      if(width===1280)await crumb.hover();
      await page.screenshot({path:join(shotsDir,`header-crumb-beside-folded-prs-${mode}-${width}x800.png`),animations:"disabled"});
    }
  }finally{await harness.close()}
});

// A thread title shows whole wherever a level of the header fit that folds no action gives it that, however long it is (UI lane D,
// 2026-10-20: at 1280 beside the Git inspector, once a second pull request was linked, the fit stopped where the title kept its
// readable 80px, and "Repo task one", 80 of its 85px, read "Repo task …" as "Repo task two" beside it would, while at 1240 the next
// levels gave it whole). Cut to the readable width, a title can lose just the words that tell it from another thread: "Repo task
// number one" (131px), longer than the 120px up to which a title had to show whole, still read "Repo task …" at 1280, as "Repo task
// number two" does, and showed more of itself at 1260 than at 1280. The header goes no further than the title and the crumb's
// shortened name need: the level before the one it takes cuts the title, or the header is at level 4 with the crumb's shortened
// name, which level 3 cannot hold (its name there is level 2 again, and level 2 cuts the title). So at 1280 both titles show whole,
// "Repo task one" with the crumb's name beside it, the theme and palette buttons stepping aside into More actions for it, and past
// level 3 the crumb keeps only its icon where its shortened name would cut the title (at 1240 it cut "Repo task number one" to
// 108px, where its icon left the title whole; at 1280 too since More actions holds the theme and palette buttons, which before it
// left nowhere in the header: UI lane C, 2026-10-21). The second pull request is linked from the palette; from 1240 to 1366 the
// title shows whole, so a wider window never shows less of it. Closing the sidebar with Ctrl+B and opening it from the header fits
// the header again.
for(const [name,sibling,crumbNamed] of [["Repo task one","Repo task two",true],["Repo task number one","Repo task number two",false]])for(const mode of ["dark","light"])test(`"${name}" shows whole beside "${sibling}" and two linked pull requests from 1240 to 1366, the header going no further than the title and the crumb's name need, in ${mode} mode`,async({page})=>{
  test.setTimeout(60_000);
  const project={id:"header-project",name:"Lane D Repository",path:process.cwd(),environmentId:null,branch:"main"};
  const threads=[name,sibling].map((title,index)=>({id:"header-thread-"+(index+1),name:title,preview:"Repo",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60-index,updatedAt:now()-index,turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Look at "+title.toLowerCase()}]},{type:"agentMessage",id:"assistant-1",text:"Looked at "+title.toLowerCase()+"."}]}]}));
  const slug=name.toLowerCase().replace(/\s+/g,"-");
  const prs=[101,102].map(number=>({url:"https://github.com/lane-d/scratch/pull/"+number,number,title:"Scratch PR "+number,state:"open"}));
  let links=prs.slice(0,1);
  const harness=await startHarness(threads);
  try{
    // The server keeps the thread's links: the Git tab syncs them, and Link pull request resolves the URL, then links it.
    await page.route(/\/api\/source-control\/thread-link$/,route=>{
      if(route.request().method()!=="POST")return route.fallback();
      const body=route.request().postDataJSON()||{};
      if(body.action==="link")links=[...links,body.pr];
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body.action==="resolve"?{pr:prs.find(pr=>pr.url===body.url)}:{links})});
    });
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads,meta:{[threads[0].id]:{projectless:false,environmentId:null,linkedPullRequests:links},[threads[1].id]:{projectless:false,environmentId:null}},project,settings:{appearanceMode:mode}});
    await openThread(page,threads[0].name);
    const right=page.getByTestId("right-panel"),header=page.locator(".chat-workspace .workspace-header");
    if(!(await right.isVisible())){await page.getByTestId("right-panel-toggle").click();await expect(right).toBeVisible()}
    await right.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
    await expect(right.locator(".linked-pr-panel h3")).toHaveText("Linked pull requests 1");
    await page.getByTestId("composer").click();await page.keyboard.press("Control+K");
    await page.keyboard.type("Link pull request",{delay:20});await page.keyboard.press("Enter");
    await expect(page.locator("dialog.inspector-text-prompt").getByRole("textbox",{name:"Pull request URL"})).toBeFocused();
    await page.keyboard.type(prs[1].url,{delay:5});await page.keyboard.press("Enter");
    await expect(right.locator(".linked-pr-panel h3")).toHaveText("Linked pull requests 2");
    // The title's box and its text's width, to the fraction of a pixel, and whether Chrome cut it with its ellipsis, and the crumb's
    // name and the least a shortened one shows (its first letter and the ellipsis, in its font), with the main column beside the
    // 258px sidebar and the 460px inspector.
    const read=()=>header.evaluate(node=>{
      const strong=node.querySelector(".thread-title-button strong"),name=node.querySelector(".project-crumb:not(.sidebar-reopen)>span"),style=getComputedStyle(name),least=document.createElement("span"),box=window.__titleBox(strong);
      least.style.cssText="position:absolute;visibility:hidden;white-space:nowrap";least.textContent=name.textContent.trim().charAt(0)+"…";
      for(const key of ["fontFamily","fontSize","fontWeight","fontStyle","fontStretch","fontFeatureSettings","fontVariationSettings","letterSpacing"])least.style[key]=style[key];
      document.body.append(least);const leastWidth=least.getBoundingClientRect().width;least.remove();
      return {fit:node.dataset.fit,crumb:node.dataset.crumb||"",title:box.shown,whole:box.whole,cut:box.cut,name:style.display==="none"?0:name.clientWidth,least:leastWidth,overflow:node.scrollWidth-node.clientWidth,chips:[...node.querySelectorAll(".header-pr")].filter(chip=>chip.offsetParent).map(chip=>chip.innerText.replace(/\s+/g,""))};
    });
    // What the title shows at another level, with the crumb as that level draws it (as the fit measures each level), and beside the
    // crumb's shortened name at this level; the header is put back as it was.
    const titleAt=level=>header.evaluate((node,level)=>{
      const fit=node.dataset.fit,crumb=node.dataset.crumb;
      node.dataset.fit=String(level);delete node.dataset.crumb;
      const box=window.__titleBox(node.querySelector(".thread-title-button strong"));
      node.dataset.fit=fit;if(crumb)node.dataset.crumb=crumb;
      return box;
    },level);
    const withName=()=>header.evaluate(node=>{
      const crumb=node.dataset.crumb;
      node.dataset.crumb="short";const box=window.__titleBox(node.querySelector(".thread-title-button strong"));
      if(crumb)node.dataset.crumb=crumb;else delete node.dataset.crumb;
      return box;
    });
    const themeLabel=mode==="dark"?"Switch to light mode":"Switch to dark mode",px=value=>value.toFixed(2);
    // The title shows whole, with no ellipsis, and the header goes no further than that and the crumb's name need: the level before
    // its own cuts the title, its ellipsis showing (at 1300 level 3 left "Repo task number one" 134 of its 135px), or the header is at
    // level 4 with the crumb's shortened name, which level 3 cannot hold beside the title (its name there would be level 2 again,
    // which cuts it). A header at level 3 or below keeps its theme and palette buttons, past it More actions holds them, and past
    // level 3 a crumb kept to its icon is so only because its shortened name would cut the title.
    const at=async(width,column=width-258-460)=>{
      await page.setViewportSize({width,height:800});
      await expect.poll(()=>header.evaluate(node=>Math.round(node.getBoundingClientRect().width))).toBe(column);await settle(page);
      const state=await read(),fit=Number(state.fit);
      console.log(`header for "${name}" at ${width}: fit ${state.fit}${state.crumb?" crumb "+state.crumb:""}, title ${px(state.title)} of ${px(state.whole)}px${state.cut?", cut":""}, crumb name ${state.name}px (least ${state.least.toFixed(1)}), chips ${state.chips.join(" ")}`);
      expect(state.overflow,`the header holds its row at ${width}px`).toBeLessThanOrEqual(1);
      expect(state.cut,`the title shows whole, with no ellipsis, at ${width}px (${px(state.title)} of ${px(state.whole)}px at data-fit ${state.fit})`).toBe(false);
      if(fit>0&&fit<6){
        const named=fit===4&&state.crumb==="short",level=named?2:fit-1,before=await titleAt(level);
        expect(before.cut,named?`level 2, which level 3 with the crumb's name would be, cuts the title at ${width}px (${px(before.shown)} of ${px(before.whole)}px)`:`level ${level} cuts the title at ${width}px (${px(before.shown)} of ${px(before.whole)}px), which needs level ${fit}`).toBe(true);
      }
      if(fit<=3)for(const label of ["Command palette",themeLabel])await expect(header.getByRole("button",{name:label,exact:true}),`${label} at ${width}px`).toBeVisible();
      else await expect(header.getByRole("button",{name:"More actions",exact:true}),`More actions, which holds the theme and palette buttons, at ${width}px`).toBeVisible();
      if(fit>3&&!state.crumb){const named=await withName();expect(named.cut,`the crumb keeps its icon at ${width}px only where its shortened name would cut the title (${px(named.shown)} of ${px(named.whole)}px, ${px(state.title)}px with the icon)`).toBe(true)}
      return state;
    };
    // At 1280 the pull requests fold into one chip and the title reads whole, the crumb keeping a shortened name beside "Repo task
    // one" and its icon beside "Repo task number one", which its name would cut.
    const wide=await at(1280);
    expect(wide.chips,"the pull requests fold into the first one's chip").toEqual(["#101+1"]);
    expect(wide.crumb,crumbNamed?"the crumb keeps a shortened name beside the title at 1280px":"the crumb keeps its icon beside the title at 1280px").toBe(crumbNamed?"short":"");
    if(crumbNamed)expect(wide.name+1,"the crumb's shortened name shows its first letter and the ellipsis at least at 1280px").toBeGreaterThanOrEqual(wide.least);
    await header.locator(".thread-title-button").hover();
    await page.screenshot({path:join(shotsDir,`header-title-${slug}-two-prs-${mode}-1280x800.png`),animations:"disabled"});
    // Narrower and wider: the title shows whole at each width, so a wider window never shows less of it than a narrower one (all of
    // its text where it is drawn whole, which its box can be a layout unit short of, else the box).
    let narrower=null;
    for(const width of [1240,1260,1280,1300,1320,1340,1366]){
      const state=await at(width),seen=state.cut?state.title:state.whole;
      if(narrower)expect(seen,`the title at ${width}px against ${narrower.width}px`).toBeGreaterThanOrEqual(narrower.seen);
      narrower={width,seen};
      if(width===1240||width===1366)await page.screenshot({path:join(shotsDir,`header-title-${slug}-two-prs-${mode}-${width}x800.png`),animations:"disabled"});
    }
    // Ctrl+B closes the sidebar and the header's Open sidebar button opens it again: each time the header fits its new width.
    await at(1280);await page.getByTestId("composer").click();
    await page.keyboard.press("Control+b");await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
    await at(1280,1280-460);
    await header.getByRole("button",{name:"Open sidebar"}).click();await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-collapsed/);
    const back=await at(1280);
    if(crumbNamed)expect(back.name+1,"the crumb keeps a shortened name with the sidebar open again").toBeGreaterThanOrEqual(back.least);
    else expect(back.crumb,"the crumb keeps its icon with the sidebar open again").toBe("");
  }finally{await harness.close()}
});

// "Repo task one" (85px) shows whole beside "Repo task two", the Git inspector and two linked pull requests at every width the
// window is dragged through, 4px at a time from 1100 to 1300 and back, and so does "Repo task number one" (135px) beside "Repo task
// number two". UI lane D, 2026-10-21: at 1140, and at 1108 beside the 224px sidebar, the fit stopped at the first level that left
// "Repo task one" its readable 80px, "Repo task …" as "Repo task two" reads, while 1136 folded one action more into More actions
// and showed it whole: a wider window showed less of the title than a narrower one. Folding one action past the readable width
// moved that to longer titles: "Repo task number one" read "Repo task …" at 1140 with one action folded while 1136 folded three
// and showed it whole, and 1152 folded one while 1164 folded two. Actions fold no further than the whole title needs (the level
// before cuts it), and a wider main column never folds more of them than a narrower one. 1140 is reached from 1280, 1120 and 1160
// too. Whole is the title's text no wider than its box, to the fraction of a pixel, as the ellipsis shows (UI lane D, round 6: the
// fit read clientWidth and scrollWidth, whole pixels, and counted a title a pixel short as whole, so where a level first shows it
// whole the pixel or two below read "Repo task o…", a box of 84.36px for 85.39px of text read 84 of 85, at 1144 with one action
// folded while 1140 folded two, at 1110, 1178, 1212, 1216 and 1284 too, "Repo task number one" at 1126, 1160, 1194, 1228, 1262 and
// 1266, and with the sidebar closed at 1125 and 1216, or the inspector at 719, 873 and 938), so the window is also dragged 1px at a
// time across each place the header changes its level, and those widths. Whole is what Chrome draws, no ellipsis, which its line
// leaves off a text up to a layout unit (a 64th of a pixel of its layout) wider than its box: counted to the exact fraction of a pixel, a
// title a unit short read as cut, so the header folded a step further than the title needs (at 1285 from level 2 to level 4, the
// theme and palette buttons stepping aside, and at 1251 the crumb took its icon back), and at 125% or 150% display scaling, where
// the box's width and its text's reach the page rounded two ways, a box that held its text could read a hundred-thousandth of a
// pixel short of it, which left whole bands of widths at the readable "Repo task …" or folded for nothing (UI fix review, round 6).
// So the header is swept at 125% and 150% too, the window stepping by the least that keeps it a whole number of device pixels,
// 4px at 125% and 2px at 150%. Where the title's box falls a unit or two short of its text, its pixels are read for the ellipsis.
// Playwright's deviceScaleFactor alone draws the page at the scale but lays it out in CSS pixels, where both widths read alike; a
// display's scaling (and the window's zoom) lays it out in device pixels, so at 125% and 150% the test runs in a browser of its own
// whose device scale factor is set as a display's scaling sets it (a probe found the exact compare misread 845 of 1352 positions of
// "Repo task one" at a forced 125%, none with the emulation alone). Under the emulation alone (Playwright's deviceScaleFactor, as
// DevTools' device mode) a layout unit is a 64th of a CSS pixel, which the fit counted as 64ths of a device pixel: at 150% the
// 85.375px box of the 85.390625px "Repo task one", one unit short and drawn whole, read two short, so beside the Git inspector the
// header folded a level more than the title needs, at 1285 to level 4, the theme and palette buttons stepping aside, and at 1251
// the crumb kept only its icon (UI lane D, round 7), and at 200% two device units are one CSS unit. So the sweep runs under the
// emulation at 150% and 200% too, its window stepping 1px at a time as at 100%, which it is laid out as.
for(const [scale,emulated] of [[1,false],[1.25,false],[1.5,false],[1.5,true],[2,true]])test.describe(`at ${scale*100}% ${emulated?"emulated device scale factor":"display scaling"}`,()=>{
// Whether the window is a whole number of device pixels at this width, as a window is (an emulated scale takes any width).
const devicePixels=width=>emulated||Number.isInteger(width*scale),fine=scale===1||emulated?1:scale===1.25?4:2;
for(const [name,sibling] of [["Repo task one","Repo task two"],["Repo task number one","Repo task number two"]])for(const mode of ["dark","light"])test(`"${name}" shows whole beside the Git inspector and two linked pull requests at every width from 1100 to 1300, the window widened and narrowed 4px at a time and ${fine}px at a time where the header changes its level, folding actions only as far as that needs, and with the sidebar or the inspector closed, in ${mode} mode`,async({page:testPage,browser,playwright,baseURL,proxy,channel,headless})=>{
  test.setTimeout(300_000);
  const project={id:"header-project",name:"Lane D Repository",path:process.cwd(),environmentId:null,branch:"main"};
  const threads=[name,sibling].map((title,index)=>({id:"header-thread-"+(index+1),name:title,preview:"Repo",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60-index,updatedAt:now()-index,turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Look at "+title.toLowerCase()}]},{type:"agentMessage",id:"assistant-1",text:"Looked at "+title.toLowerCase()+"."}]}]}));
  const slug=name.toLowerCase().replace(/\s+/g,"-");
  const prs=[102,103].map(number=>({url:"https://github.com/lane-d/scratch/pull/"+number,number,title:"Scratch PR "+number,state:"open"}));
  let links=prs.slice(0,1);
  const harness=await startHarness(threads);let scaled=null,context=null;
  try{
    // At 125% and 150% a browser of the test's own, its device scale factor set as a display's scaling sets it; emulated, a context
    // of the test's browser with the device scale factor alone.
    if(scale!==1&&!emulated)scaled=await playwright.chromium.launch({headless,channel,args:["--force-device-scale-factor="+scale]});
    if(scale!==1)context=await (scaled||browser).newContext({baseURL,proxy,viewport:{width:1280,height:800},deviceScaleFactor:scale});
    const page=context?await context.newPage():testPage;
    if(emulated)await page.addInitScript(()=>{window.__layoutZoom=1});
    expect(await page.evaluate(()=>devicePixelRatio),"the page's device pixels to a CSS pixel").toBe(scale);
    // The server keeps the thread's links: the Git tab syncs them, and Link pull request resolves the URL, then links it.
    await page.route(/\/api\/source-control\/thread-link$/,route=>{
      if(route.request().method()!=="POST")return route.fallback();
      const body=route.request().postDataJSON()||{};
      if(body.action==="link")links=[...links,body.pr];
      return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body.action==="resolve"?{pr:prs.find(pr=>pr.url===body.url)}:{links})});
    });
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads,meta:{[threads[0].id]:{projectless:false,environmentId:null,linkedPullRequests:links},[threads[1].id]:{projectless:false,environmentId:null}},project,settings:{appearanceMode:mode}});
    await openThread(page,threads[0].name);
    const right=page.getByTestId("right-panel"),header=page.locator(".chat-workspace .workspace-header");
    if(!(await right.isVisible())){await page.getByTestId("right-panel-toggle").click();await expect(right).toBeVisible()}
    await right.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
    await expect(right.locator(".linked-pr-panel h3")).toHaveText("Linked pull requests 1");
    await page.getByTestId("composer").click();await page.keyboard.press("Control+K");
    await page.keyboard.type("Link pull request",{delay:20});await page.keyboard.press("Enter");
    await expect(page.locator("dialog.inspector-text-prompt").getByRole("textbox",{name:"Pull request URL"})).toBeFocused();
    await page.keyboard.type(prs[1].url,{delay:5});await page.keyboard.press("Enter");
    await expect(right.locator(".linked-pr-panel h3")).toHaveText("Linked pull requests 2");
    const title=header.locator(".thread-title-button strong");
    // The header's level, crumb and folded actions (in the order they fold), and the title as Chrome lays it out (its box, the width
    // of its text and whether the ellipsis cuts it: window.__titleBox), then the same at the level before: one action fewer folded,
    // else the level below (level 2 for level 4 with the crumb's shortened name, which level 3 with it would be), with the crumb's
    // icon as the fit measures each level; and where the crumb keeps its icon from level 3 on, beside its shortened name as the fit
    // tries it (at level 4 for level 3). The header is put back as it was.
    const read=()=>header.evaluate((node,order)=>{
      const strong=node.querySelector(".thread-title-button strong"),row=node.querySelector(".workspace-header-actions"),fit=node.dataset.fit,crumb=node.dataset.crumb;
      const folded=order.filter(id=>row.querySelector(`:scope>[data-fold="${id}"]`)?.hasAttribute("data-folded")),box=window.__titleBox(strong);
      const state={fit,crumb:crumb||"",folded,column:Math.round(node.getBoundingClientRect().width),box,title:box.shown,whole:box.whole,pixels:strong.clientWidth+" of "+strong.scrollWidth,overflow:node.scrollWidth-node.clientWidth,chips:[...node.querySelectorAll(".header-pr")].filter(chip=>chip.offsetParent).map(chip=>chip.innerText.replace(/\s+/g,""))};
      if(fit!=="0"){
        const back=folded.length?[...node.querySelectorAll(`[data-fold="${folded.at(-1)}"]`)]:[];
        for(const control of back)control.removeAttribute("data-folded");
        node.dataset.fit=folded.length===1?"5":folded.length?fit:fit==="4"&&crumb==="short"?"2":String(Number(fit)-1);delete node.dataset.crumb;
        state.before=window.__titleBox(strong);
        for(const control of back)control.setAttribute("data-folded","");
        node.dataset.fit=fit;if(crumb)node.dataset.crumb=crumb;
      }
      if(Number(fit)>=3&&!crumb){
        if(fit==="3")node.dataset.fit="4";node.dataset.crumb="short";
        state.named=window.__titleBox(strong);
        node.dataset.fit=fit;delete node.dataset.crumb;
      }
      return state;
    },HEADER_FOLD_ORDER);
    // The main column beside the sidebar (224px up to 1120, 258px from 1121) and the 460px inspector, or as wide as column says.
    const seen=[],px=value=>value.toFixed(2),level=state=>state.fit+(state.folded.length?"+"+state.folded.length:"")+(state.crumb?" crumb "+state.crumb:"");
    const shot=width=>join(shotsDir,`header-title-${slug}-git-inspector-${mode}-${width}x800${scale===1?"":"-at-"+scale*100+"pct"}${emulated?"-emulated":""}.png`);
    const at=async(width,column=width-(width<=1120?224:258)-460)=>{
      await page.setViewportSize({width,height:800});
      await expect.poll(async()=>Math.abs(await header.evaluate(node=>node.getBoundingClientRect().width)-column),{message:`the main column at ${width}px`}).toBeLessThan(scale===1?0.5:1);await settle(page);
      const state=await read(),short=unitsShort(state.box),where=`at ${width}px (data-fit ${state.fit}${state.crumb?" crumb "+state.crumb:""}${state.folded.length?" folded "+state.folded.join(" "):""}, title ${px(state.title)}px for its text's ${px(state.whole)}px, ${short} layout units short${state.box.cut?", cut":""}, ${state.pixels} in whole pixels, chips ${state.chips.join(" ")})`;
      seen.push({width,...state});
      expect.soft(state.overflow,`the header holds its row ${where}`).toBeLessThanOrEqual(1);
      expect.soft(state.box.cut,`"${name}" shows whole, with no ellipsis, ${where}`).toBe(false);
      if(state.box.cut)await page.screenshot({path:shot(width+"-cut"),animations:"disabled"});
      // A box a unit or two short of its text: its pixels show the ellipsis where its Range says Chrome cut it, and only there.
      if(short===1||short===2)expect.soft(await ellipsisDrawn(title),`the title's pixels ${state.box.cut?"show":"show no"} ellipsis, as its Range says, ${where}`).toBe(state.box.cut);
      if(state.before)expect.soft(state.before.cut,`the level before cuts the title (${px(state.before.shown)}px for ${px(state.before.whole)}px), so the header goes no further than it needs, ${where}`).toBe(true);
      if(state.named)expect.soft(state.named.cut,`the crumb keeps its icon only where its shortened name would cut the title (${px(state.named.shown)}px for ${px(state.named.whole)}px), ${where}`).toBe(true);
      // The fit's own measure says what Chrome draws, for the title, at the level before and beside the crumb's name alike.
      for(const [what,box] of [["the title",state.box],["the title at the level before",state.before],["the title beside the crumb's name",state.named]])if(box)expect.soft(titleWhole(box),`the fit's measure of ${what} (${px(box.shown)}px for ${px(box.whole)}px, ${unitsShort(box)} layout units short) says what Chrome draws, ${where}`).toBe(!box.cut);
      return state;
    };
    const wide=await at(1280);
    expect(wide.chips,"the pull requests fold into the first one's chip").toEqual(["#102+1"]);
    expect.soft(Math.abs(wide.title-wide.whole),"at 1280 the title's box is its text's own width, as the Range reads it").toBeLessThan(0.02);
    // 1140 from 1280, from 1120 and from 1160.
    for(const from of [null,1120,1160]){if(from)await at(from);await at(1140)}
    await page.screenshot({path:shot(1140),animations:"disabled"});
    for(let width=1100;width<=1300;width+=4)await at(width);
    for(let width=1300;width>=1100;width-=4){await at(width);if(width===1108||width===1152)await page.screenshot({path:shot(width),animations:"disabled"})}
    // 1px at a time (at 125% and 150% display scaling by the least step that keeps whole device pixels), widening and then
    // narrowing, from 2px below to 2px above each pair of 4px steps the header changed its level between, and at the widths lane D
    // and the fix review found the title cut or folded past its need at.
    const band=new Set(scale===1||emulated?[1110,1111,1144,1145,1178,1179,1212,1216,1217,1251,1284,1285,1126,1160,1194,1228,1262,1266]:[]);
    for(const [index,state] of seen.entries()){const next=seen[index+1];if(next&&Math.abs(next.width-state.width)===4&&level(next)!==level(state))for(let width=Math.min(state.width,next.width)-2;width<=Math.max(state.width,next.width)+2;width++)band.add(width)}
    const widths=[...band].filter(width=>width>=1100&&width<=1300&&devicePixels(width)).sort((a,b)=>a-b);
    for(const width of widths){await at(width);if(width===1110||width===1144||width===1285)await page.screenshot({path:shot(width),animations:"disabled"})}
    for(const width of widths.reverse())await at(width);
    const line=seen.map(state=>`${state.width}:${level(state)}:${px(state.title)}/${px(state.whole)}${state.box.cut?" cut":""}`).join(" ");
    console.log(`header for "${name}" beside the Git inspector in ${mode} at ${scale*100}%${emulated?" emulated":""} (width:fit+folds:title/whole): ${line}`);
    // A wider main column never folds more actions than a narrower one (the column narrows where the sidebar widens at 1121).
    const more=new Set();for(const state of seen)for(const other of seen)if(other.column>state.column&&other.folded.length>state.folded.length)more.add(`${other.width}px (${other.column}px of column) folds ${other.folded.length}, ${state.width}px (${state.column}px) ${state.folded.length}`);
    expect.soft([...more],"a wider main column never folds more actions than a narrower one").toEqual([]);
    // The same 1px at a time, widening and narrowing, with the sidebar closed by Ctrl+B beside the inspector, then beside the sidebar
    // alone once the inspector's toggle has closed it, where lane D found the title cut too (1125-1126 and 1216-1217, and 719, 873
    // and 938-939). Below 820px the sidebar closes by itself, and up to 900px it is 196px wide.
    const main=seen.length,range=(from,to)=>Array.from({length:to-from+1},(_,index)=>from+index);
    const sweep=async(spans,column)=>{for(const [from,to] of spans)for(const width of [...range(from,to),...range(from,to).reverse()].filter(devicePixels))await at(width,column(width))};
    await at(1280);await page.getByTestId("composer").click();
    await page.keyboard.press("Control+b");await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
    await sweep([[1121,1130],[1212,1221]],width=>width-460);
    await header.getByRole("button",{name:"Open sidebar"}).click();await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-collapsed/);
    await page.getByTestId("right-panel-toggle").click();await expect(right).toBeHidden();
    await sweep([[715,723],[869,877],[934,943]],width=>width-(width<820?0:width<=900?196:224));
    console.log(`header for "${name}" with the sidebar closed, then without the inspector, in ${mode} at ${scale*100}%${emulated?" emulated":""}: ${seen.slice(main).map(state=>`${state.width}:${level(state)}:${px(state.title)}/${px(state.whole)}${state.box.cut?" cut":""}`).join(" ")}`);
  }finally{await harness.close();await context?.close();await scaled?.close()}
});
});

// A linked pull request's chip opens its page in a new tab that cannot reach back into the app; a link that is not a web address
// (saved metadata carrying a javascript: URL) opens nothing. Pressed like a person, shot before and after in both modes.
for(const mode of ["dark","light"])test(`a linked pull request opens its web page and a link that is not a web address opens nothing, in ${mode} mode`,async({page})=>{
  test.setTimeout(35_000);
  const project={id:"header-project",name:"Billing reconciliation",path:process.cwd(),environmentId:null,branch:"main"};
  const thread={id:"header-thread",name:"Refunds counted twice",preview:"Refunds",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Why are refunds counted twice?"}]},{type:"agentMessage",id:"assistant-1",text:"Looking."}]}]};
  const prs=[{url:"https://github.com/acme/billing/pull/12345",number:12345,title:"Refund fix",state:"open"},{url:"javascript:document.title='opened'",number:12346,title:"Tampered link",state:"open"}];
  const harness=await startHarness([thread]);
  try{
    await page.addInitScript(()=>{window.__opened=[];window.open=(...args)=>{window.__opened.push(args.map(String));return null}});
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:false,environmentId:null,linkedPullRequests:prs}},project,settings:{appearanceMode:mode},layout:{sidebarWidth:258,rightPanelWidth:520,terminalHeight:330}});
    await openThread(page,thread.name);
    if(await page.getByTestId("right-panel").isVisible()){await page.getByTestId("right-panel-toggle").click();await expect(page.getByTestId("right-panel")).toBeHidden()}
    const header=page.locator(".chat-workspace .workspace-header");
    const web=header.getByRole("button",{name:"Pull request #12345"}),tampered=header.getByRole("button",{name:"Pull request #12346"});
    await expect(web).toBeVisible();await expect(tampered).toBeVisible();await settle(page);
    await page.screenshot({path:join(shotsDir,`header-pr-open-before-${mode}-1280x800.png`),animations:"disabled"});
    await web.click();
    await expect.poll(()=>page.evaluate(()=>window.__opened)).toEqual([["https://github.com/acme/billing/pull/12345","_blank","noopener,noreferrer"]]);
    await tampered.click();await page.waitForTimeout(300);
    expect(await page.evaluate(()=>window.__opened),"the tampered link opened nothing").toHaveLength(1);
    expect(await page.title()).not.toBe("opened");
    await expect(header).toBeVisible();
    await page.screenshot({path:join(shotsDir,`header-pr-open-after-${mode}-1280x800.png`),animations:"disabled"});
  }finally{await harness.close()}
});

// The header fixture for the narrow-window tests below: every header action there is (the branch, the desktop app's Open-in
// picker, a project action, Review, the terminal and goal toggles), long names, prCount linked pull requests, and Stop while a
// turn runs. The desktop bridge records each Open in window.__opens, answers it once window.__openHold (a promise, when set)
// settles, and while window.__openFails is set fails it as the shell does for an editor whose program is gone (editorGone). others
// are more threads for the sidebar, each linked to the first otherPrs of the pull requests.
async function openHeaderFixture(page,{width,height=800,mode="dark",prCount=3,running=true,editors=[{id:"vscode",label:"Visual Studio Code"}],others=[],otherPrs=0,settings={},respond}){
  await page.addInitScript(editors=>{window.__opens=[];window.__openFails=false;Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{openIn:{list:async()=>({editors}),open:async(path,id)=>{window.__opens.push(id);await window.__openHold;if(window.__openFails)throw new Error("Could not start "+editors.find(editor=>editor.id===id).label+": it is no longer at D:\\Editors\\"+id+".exe.")}}}})},editors);
  const project={id:"header-project",name:"Billing reconciliation service with a very long project name",path:process.cwd(),environmentId:null,branch:"feature/reconcile-refunds-in-the-ledger-export",scripts:[{id:"dev-server",name:"Start the billing dev server",command:"npm run dev -- --port 4173"}],preferredScriptId:"dev-server"};
  const thread={id:"header-thread",name:"Investigate why the nightly billing reconciliation job double counts refunds in the ledger export",preview:"Refunds",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Why are refunds counted twice?"}]},{type:"agentMessage",id:"assistant-1",text:"Looking."}]}]};
  const prs=Array.from({length:prCount},(_,index)=>({url:"https://github.com/acme/billing/pull/"+(12345+index),number:12345+index,title:"Refund fix "+index,state:"open"}));
  const harness=await startHarness([thread,...others],{respond});
  try{
    await page.setViewportSize({width,height});
    await openApp(page,{harness,threads:[thread,...others],meta:{[thread.id]:{projectless:false,environmentId:null,linkedPullRequests:prs},...Object.fromEntries(others.map(other=>[other.id,{projectless:false,environmentId:null,...(otherPrs?{linkedPullRequests:prs.slice(0,otherPrs)}:{})}]))},project,settings:{appearanceMode:mode,...settings},layout:{sidebarWidth:258,rightPanelWidth:520,terminalHeight:330}});
    await openThread(page,thread.name);
    const header=page.locator(".chat-workspace .workspace-header");
    await expect(header.locator(".open-in-wrap")).toBeVisible();
    await expect(header.getByRole("button",{name:project.scripts[0].name,exact:true})).toBeVisible();
    if(running)await startTurn(page,header);
    await page.getByTestId("right-panel-toggle").click();
    await expect(page.getByTestId("right-panel")).toBeVisible();await settle(page);
    return {harness,project,thread,header,title:header.locator(".thread-title-button strong"),more:header.getByRole("button",{name:"More actions",exact:true}),menu:page.getByTestId("header-overflow-menu")};
  }catch(error){await harness.close();throw error}
}
// The shell's sentence for an Open whose editor's program is gone (desktop/editor-discovery.mjs startEditor), as the fixture fails it.
const editorGone=(label,id)=>`Could not start ${label}: it is no longer at D:\\Editors\\${id}.exe.`;
async function startTurn(page,header){
  await page.getByTestId("composer").fill("Keep going.");await page.getByTestId("send").click();
  await expect(header.getByRole("button",{name:"Stop",exact:true})).toBeVisible();await settle(page);
}
async function endTurn(page,harness,thread,header){
  harness.push("turn/completed",{threadId:thread.id,turn:{id:"turn-live",status:"completed",completedAt:now()}});
  await expect(header.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0);await settle(page);
}
// Presses Tab until the open More actions menu's item named name (exact for a string) has focus.
async function tabToMenuItem(page,menu,name){
  const item=menu.getByRole("button",typeof name==="string"?{name,exact:true}:{name});
  for(let step=0;step<16&&!(await item.evaluate(node=>node===document.activeElement));step++)await page.keyboard.press("Tab");
  await expect(item).toBeFocused();
  return item;
}
const focusVisible=locator=>locator.evaluate(node=>node.matches(":focus-visible"));
// The order the header's actions fold in (their data-fold), from the end of the row; Stop and the inspector toggle never fold.
const HEADER_FOLD_ORDER=["goal","terminal","review","script","open-in","source"];
// The header's foldable actions and the folded ones, in the order they fold, and the title as Chrome lays it out (its box, its
// text's width and whether the ellipsis cuts it: window.__titleBox) now, with the last folded action given back to the row, and with
// every action folded, the last two with the crumb's icon as the fit measures each level; the header is put back as it was. The fit
// takes the first level that shows the title whole, however many actions that folds, so one action fewer folded cuts a whole title;
// where every action folded cuts it too, it folds no more than a readable title needs, so one action fewer folded leaves it short of
// the readable 80px.
const headerFold=header=>header.evaluate((node,order)=>{
  const row=node.querySelector(".workspace-header-actions"),title=node.querySelector(".thread-title-button strong");
  const present=order.filter(id=>row.querySelector(`:scope>[data-fold="${id}"]`)),folded=present.filter(id=>row.querySelector(`:scope>[data-fold="${id}"]`).hasAttribute("data-folded"));
  const fit=node.dataset.fit,crumb=node.dataset.crumb,marked=[...node.querySelectorAll("[data-fold]")],markedFolded=marked.filter(control=>control.hasAttribute("data-folded"));
  const box=window.__titleBox(title),state={fit,present,folded,box,title:box.shown,whole:box.whole,withOneLess:null,allFolded:null};
  delete node.dataset.crumb;
  if(folded.length){
    for(const control of marked)if(control.dataset.fold===folded.at(-1))control.removeAttribute("data-folded");
    if(folded.length===1)node.dataset.fit="5";
    state.withOneLess=window.__titleBox(title);
  }
  node.dataset.fit=present.length?"6":"5";for(const control of marked)control.toggleAttribute("data-folded",present.includes(control.dataset.fold));
  state.allFolded=window.__titleBox(title);
  node.dataset.fit=fit;if(crumb)node.dataset.crumb=crumb;for(const control of marked)control.toggleAttribute("data-folded",markedFolded.includes(control));
  return state;
},HEADER_FOLD_ORDER);
// Which of the row's controls draws the line that parts the labelled actions from the icon toggles.
const headerSeparators=header=>header.locator(".workspace-header-actions>*").evaluateAll(nodes=>nodes.filter(node=>node.offsetParent&&getComputedStyle(node,"::before").content!=="none").map(node=>node.getAttribute("aria-label")||node.className));
const firstShownToggle=header=>header.locator(".workspace-header-actions>.header-control.icon-only").evaluateAll(nodes=>nodes.find(node=>node.offsetParent)?.getAttribute("aria-label")||null);
async function expectFoldedOnlyAsNeeded(header,state){
  expect(state.folded,"folded actions").toEqual(state.present.slice(0,state.folded.length));
  expect(state.title+1,"title width").toBeGreaterThanOrEqual(Math.min(state.whole,80));
  // The title shows whole wherever a level shows it so: a cut title is cut with every action folded too. Actions fold as far as the
  // whole title needs, or where no level shows it whole as far as a readable one needs.
  const whole=!state.box.cut;
  if(!whole)expect(state.allFolded.cut,`the title with every action folded, beside a cut title (${state.allFolded.shown}px for ${state.allFolded.whole}px)`).toBe(true);
  if(state.folded.length){
    if(whole)expect(state.withOneLess.cut,`the title with one action fewer folded (${state.withOneLess.shown}px for ${state.withOneLess.whole}px)`).toBe(true);
    else expect(state.withOneLess.shown+1,"title width with one action fewer folded").toBeLessThan(Math.min(state.whole,80));
  }
  for(const id of state.present)await expect(header.locator(`.workspace-header-actions>[data-fold="${id}"]`),id).toBeVisible({visible:!state.folded.includes(id)});
  // More actions shows from the level that sets the theme and palette buttons aside, which comes before any fold.
  await expect(header.getByRole("button",{name:"More actions",exact:true})).toBeVisible({visible:Number(state.fit)>=4});
}

// The desktop window at its minimum size (1180x800, about 400px of main column beside the 520px inspector) and at 1280x800,
// with every header action, a running turn, three linked pull requests and long names. Icon-only actions alone leave the title
// no room, so actions fold into a More actions menu one at a time from the end of the row, only as many as the title needs
// (Stop and the inspector toggle stay), and the title keeps a readable width. The menu lists the folded ones.
for(const [width,height] of [[1180,800],[1280,800]])for(const mode of ["dark","light"])test(`the header names the open thread beside every action at ${width}x${height} with the 520px inspector in ${mode} mode`,async({page})=>{
  test.setTimeout(45_000);
  const {harness,project,header,title,more,menu}=await openHeaderFixture(page,{width,height,mode});
  try{
    // The inspector keeps the person's 520px; the main column is what is left of the window.
    expect(Math.round((await page.getByTestId("right-panel").boundingBox()).width)).toBe(520);
    expect(Math.round((await header.boundingBox()).width)).toBe(width-258-520);
    await expect(title).toBeVisible();
    const metrics=await header.evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    const state=await headerFold(header);
    expect(state.fit).toBe("6");expect(state.present).toEqual(HEADER_FOLD_ORDER);
    await expectFoldedOnlyAsNeeded(header,state);
    // Stop and the inspector toggle stay in the header, beside the menu that holds what folded; the first toggle still shown
    // keeps the line that parts it from the labelled actions.
    await expect(header.getByRole("button",{name:"Stop",exact:true})).toBeVisible();await expect(page.getByTestId("right-panel-toggle")).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded","false");
    expect(await headerSeparators(header)).toEqual([await firstShownToggle(header)]);
    for(const name of ["Command palette",mode==="dark"?"Switch to light mode":"Switch to dark mode"])await expect(header.getByRole("button",{name,exact:true}),name).toBeHidden();
    await page.screenshot({path:join(shotsDir,`header-overflow-${mode}-${width}x${height}.png`),animations:"disabled"});
    // The menu lists the folded actions in the header's order, then the theme and palette buttons, inside the main column.
    await more.click();await expect(more).toHaveAttribute("aria-expanded","true");
    await expect(menu).toBeVisible();
    const labels={source:"Source control"+project.branch,script:project.scripts[0].name,review:"Review",terminal:"Terminal",goal:"Thread goal"};
    const rowOrder=["source","open-in","script","review","terminal","goal"];
    await expect(menu.locator(":scope>button:visible")).toHaveText([...rowOrder.filter(id=>state.folded.includes(id)&&labels[id]).map(id=>labels[id]),mode==="dark"?"Switch to light mode":"Switch to dark mode","Command paletteCtrl+K"]);
    await expect(menu.locator(".open-in-wrap")).toBeVisible({visible:state.folded.includes("open-in")});
    const box=await menu.boundingBox(),column=await header.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(column.x);expect(box.x+box.width).toBeLessThanOrEqual(column.x+column.width+1);
    await page.screenshot({path:join(shotsDir,`header-overflow-menu-${mode}-${width}x${height}.png`),animations:"disabled"});
    // Escape closes it and puts focus back on its button; a chosen action runs and closes it.
    await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);await expect(more).toBeFocused();
    if(state.folded.includes("terminal")){
      await more.click();await menu.getByRole("button",{name:"Terminal"}).click();
      await expect(page.getByTestId("drawer")).toBeVisible();await expect(menu).toHaveCount(0);
      await more.click();await expect(menu.getByRole("button",{name:"Terminal"})).toHaveAttribute("aria-pressed","true");
    }else await more.click();
    await menu.getByRole("button",{name:"Command palette"}).click();await expect(menu).toHaveCount(0);
    await expect(page.getByPlaceholder(/Search commands/i)).toBeVisible();await page.keyboard.press("Escape");
    // A click outside closes it too.
    await more.click();await expect(menu).toBeVisible();await page.mouse.click(column.x+column.width/2,400);await expect(menu).toHaveCount(0);
    // Closing the inspector gives the actions back to the row, and the menu goes.
    await page.getByTestId("right-panel-toggle").click();await settle(page);
    expect(Number(await header.getAttribute("data-fit"))).toBeLessThan(6);
    await expect(more).toBeHidden();await expect(header.locator("[data-folded]")).toHaveCount(0);
    for(const name of ["Review","Stop","Toggle terminal","Thread goal",project.scripts[0].name])await expect(header.getByRole("button",{name,exact:true}),name).toBeVisible();
    await expect(header.locator(".branch-control")).toBeVisible();await expect(header.locator(".workspace-header-actions>.open-in-wrap")).toBeVisible();
  }finally{await harness.close()}
});

// A project action that runs while the header has folded it away keeps its Stop in reach: More actions holds a Stop item for it,
// beside the action's own item (which says it is running and shows its terminal), as the row does with its Stop button. More
// actions opened again while the action's terminal is still coming up (the drawer lists its terminals late here) stays open as that
// terminal shows, with the keyboard where the person left it, and takes the click: the terminal took the keyboard as it came up,
// which closed the menu under the pointer. The same holds for the menu opened with the keyboard, and for the menu opened again while
// the run is still on its way (a real run answers in up to a second or so), before its answer opens the drawer.
test("a running project action folded into More actions is stopped from there, where its Stop sits beside it, and More actions opened while its terminal comes up stays open",async({page})=>{
  test.setTimeout(60_000);
  const {harness,project,header,more,menu}=await openHeaderFixture(page,{width:1180,running:false});
  const script=project.scripts[0],runs=[],sockets=new Set(),drawer=page.getByTestId("drawer");
  const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  const session=run=>({id:run.id,name:script.name,cwd:project.path,environmentId:null,environmentName:"Local machine",environmentType:"local",cols:120,rows:32,running:run.running,exitCode:run.running?null:1,createdAt:Date.now(),updatedAt:Date.now(),buffer:""});
  // hold() keeps the drawer's next listing of its terminals until listed() is called.
  let listing=Promise.resolve(),listed=()=>{};const hold=()=>{listing=new Promise(resolve=>listed=resolve)};
  // holdRun() keeps the answer to the next run until answer() is called.
  let answering=Promise.resolve(),answer=()=>{};const holdRun=()=>{answering=new Promise(resolve=>answer=resolve)};
  try{
    // The server's side of a run: it answers with the terminal it started, which runs until Stop.
    await page.route(/\/api\/project-script\/run$/,async route=>{await answering;const run={id:"folded-run-"+(runs.length+1),running:true};runs.push(run);return json(route,{ok:true,script,session:session(run),previewUrl:null})});
    await page.route(/\/api\/project-script\/stop$/,route=>{
      const run=runs.find(item=>item.running);
      if(run){run.running=false;for(const ws of sockets)ws.send(JSON.stringify({type:"exit",exitCode:1,signal:null}))}
      return json(route,{ok:true,session:run?session(run):null});
    });
    await page.route(/\/api\/terminal\/sessions(?:\?.*)?$/,async route=>{if(route.request().method()!=="GET")return route.fallback();await listing;return json(route,{sessions:runs.map(session)})});
    await page.route(/\/api\/project-script\/runs(?:\?.*)?$/,route=>json(route,{runs:{}}));
    await page.routeWebSocket(/\/api\/terminal\/ws\?/,ws=>{
      const url=new URL(ws.url()),run=runs.find(item=>item.id===url.searchParams.get("session"));sockets.add(ws);ws.onClose(()=>sockets.delete(ws));
      if(url.searchParams.get("watch")==="1"){ws.send(JSON.stringify({type:"state",running:Boolean(run?.running),exitCode:null}));return}
      ws.send(JSON.stringify({type:"snapshot",session:{...(run?session(run):{}),buffer:"DEV SERVER READY\r\n"}}));
    });
    // The window narrows until the header folds the action into More actions.
    const control=header.locator(".workspace-header-actions>.script-control");
    let width=1180;
    while(width>760&&await control.getAttribute("data-folded")==null){width-=40;await page.setViewportSize({width,height:800});await settle(page)}
    await expect(control).toHaveAttribute("data-folded",/.*/);
    const runItem=menu.getByRole("button",{name:new RegExp("^"+script.name)}),stopItem=menu.getByRole("button",{name:"Stop "+script.name});
    await more.click();await expect(stopItem).toHaveCount(0);hold();await runItem.click();
    await expect(control).toHaveAttribute("data-running","true");
    await expect(header.getByRole("button",{name:"Stop "+script.name,exact:true})).toBeHidden();
    // The run opened the drawer, whose terminal is still coming up when the menu is opened again.
    await expect(drawer).toContainText("Loading terminal…");
    await more.click();await expect(menu).toBeVisible();
    listed();await expect(drawer.locator(".terminal-tab")).toHaveCount(1);await settle(page);
    await expect(menu,"More actions stays open as the action's terminal comes up").toBeVisible();await expect(more,"the keyboard stays on More actions").toBeFocused();
    await menu.getByRole("button",{name:"Switch to light mode",exact:true}).click();await expect(page.locator("html")).toHaveAttribute("data-mode","light");
    for(const mode of ["dark","light"]){
      if(await page.locator("html").getAttribute("data-mode")!==mode){await more.click();await menu.getByRole("button",{name:/^Switch to (light|dark) mode$/}).click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode)}
      await more.click();
      await expect(runItem).toContainText("Running");await expect(runItem).toHaveAttribute("title",script.name+" is running · Show its terminal");
      await expect(stopItem).toBeVisible();
      await page.screenshot({path:join(shotsDir,"header-overflow-action-stop-"+mode+"-"+width+"x800.png"),animations:"disabled"});
      await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
    }
    // From the keyboard, with the drawer closed: the action's item (it runs already) shows its terminal again, and More actions
    // opened with Enter while that terminal comes up stays open too.
    await drawer.getByRole("button",{name:"Close terminal",exact:true}).click();await expect(drawer).toHaveCount(0);
    hold();await more.focus();await page.keyboard.press("Enter");await tabToMenuItem(page,menu,new RegExp("^"+script.name));await page.keyboard.press("Enter");
    await expect(drawer).toContainText("Loading terminal…");await expect(more).toBeFocused();
    await page.keyboard.press("Enter");await expect(menu).toBeVisible();
    listed();await expect(drawer.locator(".terminal-tab")).toHaveCount(1);await settle(page);
    await expect(menu,"More actions opened with Enter stays open as the terminal comes up").toBeVisible();await expect(more,"the keyboard stays on More actions").toBeFocused();
    await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
    await more.click();await stopItem.click();
    await expect(control).not.toHaveAttribute("data-running","true");
    expect(runs.map(run=>run.running)).toEqual([false]);
    // Stopped, the menu offers the action again and no Stop.
    await more.click();await expect(stopItem).toHaveCount(0);await expect(runItem).toBeVisible();await expect(runItem).not.toContainText("Running");
    // Run from the menu with the drawer closed, by mouse and then from the keyboard, and More actions opened again while the run is
    // on its way: it stays open as the answer opens the drawer and the action's terminal comes up, with the keyboard on its button.
    // The answer asked for the keyboard as it came, after the press that opened the menu again.
    await page.keyboard.press("Escape");await drawer.getByRole("button",{name:"Close terminal",exact:true}).click();await expect(drawer).toHaveCount(0);
    for(const way of ["mouse","keyboard"]){
      holdRun();
      if(way==="mouse"){await more.click();await runItem.click();await expect(menu).toHaveCount(0);await more.click()}
      else{await more.focus();await page.keyboard.press("Enter");await tabToMenuItem(page,menu,new RegExp("^"+script.name));await page.keyboard.press("Enter");await expect(menu).toHaveCount(0);await expect(more).toBeFocused();await page.keyboard.press("Enter")}
      await expect(menu).toBeVisible();await expect(drawer).toHaveCount(0);
      answer();await expect(control).toHaveAttribute("data-running","true");
      await expect(drawer.locator(".terminal-tab")).toHaveCount(runs.length);await expect(drawer.locator(".terminal-pane.active .terminal-command-line input")).toBeEnabled();await settle(page);
      await expect(menu,"More actions opened while the run was on its way stays open as its terminal comes up ("+way+")").toBeVisible();await expect(more,"the keyboard stays on More actions").toBeFocused();
      await stopItem.click();await expect(control).not.toHaveAttribute("data-running","true");
      await drawer.getByRole("button",{name:"Close terminal",exact:true}).click();await expect(drawer).toHaveCount(0);
    }
    expect(runs.map(run=>run.running)).toEqual([false,false,false]);
  }finally{await harness.close()}
});

// The server's side of a terminal that comes up a while after the press that asked for it, for the tests below: the list holds the
// terminals in listed (none until a test adds one), and a terminal's socket says it runs and what it printed. A held request answers
// once its release() is called.
async function lateTerminals(page){
  const listed=[],json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
  await page.route(/\/api\/terminal\/sessions(?:\?.*)?$/,route=>route.request().method()==="GET"?json(route,{sessions:listed}):route.fallback());
  await page.route(/\/api\/project-script\/runs(?:\?.*)?$/,route=>json(route,{runs:{}}));
  await page.routeWebSocket(/\/api\/terminal\/ws\?/,ws=>{
    const url=new URL(ws.url()),session=listed.find(item=>item.id===url.searchParams.get("session"));
    if(url.searchParams.get("watch")==="1"){ws.send(JSON.stringify({type:"state",running:Boolean(session?.running),exitCode:null}));return}
    ws.send(JSON.stringify({type:"snapshot",session:{...(session||{}),buffer:"Starting\r\n"}}));
  });
  const terminal=(id,name,cwd)=>({id,name,cwd,environmentId:null,environmentName:"Local machine",environmentType:"local",cols:120,rows:32,running:true,exitCode:null,createdAt:Date.now(),updatedAt:Date.now(),buffer:""});
  const held=()=>{let release=()=>{};const answered=new Promise(resolve=>release=resolve);return {answered,release}};
  return {listed,terminal,held,json};
}
// The terminal came up with More actions open: it stays open, with the keyboard on its button, and takes the click.
async function expectMoreActionsKept(page,{more,menu,drawer},what){
  await expect(drawer.locator(".terminal-tab")).toHaveCount(1);await expect(drawer.locator(".terminal-pane.active .terminal-command-line input")).toBeEnabled();await settle(page);
  await expect(menu,"More actions stays open as "+what+" comes up").toBeVisible();await expect(more,"the keyboard stays on More actions").toBeFocused();
}

// An action run from its Projects card shows its terminal on the chat when the run answers, which a real run does in up to a second
// or so. More actions opened on the thread meanwhile stays open as that terminal comes up: the card's run asked for the terminal's
// keyboard as it answered, after the press that opened the menu, where the header's run asks as of the press that ran it.
test("More actions opened on the thread while an action run from its Projects card starts stays open as the action's terminal comes up",async({page})=>{
  test.setTimeout(60_000);
  const {harness,project,thread,header,more,menu}=await openHeaderFixture(page,{width:1180,running:false});
  const script=project.scripts[0],drawer=page.getByTestId("drawer");
  try{
    const {listed,terminal,held,json}=await lateTerminals(page),run=held();
    await page.route(/\/api\/project-script\/run$/,async route=>{await run.answered;const session=terminal("card-run",script.name,project.path);listed.push(session);return json(route,{ok:true,script,session,previewUrl:null})});
    await expect(more).toBeVisible();
    await header.locator(".project-crumb:not(.sidebar-reopen)").click();
    await page.locator(".project-card.active .project-action-run").filter({hasText:script.name}).click();
    // Back on the thread while the run is on its way, More actions is opened.
    await openThread(page,thread.name);
    await more.click();await expect(menu).toBeVisible();await expect(drawer).toHaveCount(0);
    run.release();
    await expect(header.locator(".workspace-header-actions>.script-control")).toHaveAttribute("data-running","true");
    await expectMoreActionsKept(page,{more,menu,drawer},"the card's run shows its terminal");
    await page.screenshot({path:join(shotsDir,"header-overflow-card-run-terminal-dark-1180x800.png"),animations:"disabled"});
    await menu.getByRole("button",{name:"Switch to light mode",exact:true}).click();await expect(page.locator("html")).toHaveAttribute("data-mode","light");
  }finally{await harness.close()}
});

// A send in New worktree mode whose worktree runs a setup script opens the drawer on that script's terminal by itself once the
// worktree is made, seconds after the press that sent it. More actions opened meanwhile stays open as that terminal comes up: the
// drawer asked for the keyboard as it opened, after the press that opened the menu, where it now asks as of the send. The worktree
// here takes the project's own folder, so the header keeps its actions (a real one is a project of its own, whose header loads its
// own Git state), and the send's thread is never answered, so the header stays the new task's.
test("More actions opened while a send's new worktree is made stays open as the worktree's setup terminal comes up",async({page})=>{
  test.setTimeout(60_000);
  const {harness,project,header,more,menu}=await openHeaderFixture(page,{width:1180,running:false,respond:message=>message.method==="thread/start"?new Promise(()=>{}):undefined});
  const drawer=page.getByTestId("drawer"),composer=page.getByTestId("composer");
  try{
    const {listed,terminal,held,json}=await lateTerminals(page),worktree=held();let asked=false;
    await page.route(/\/api\/git\/action$/,async route=>{
      if(route.request().postDataJSON()?.action!=="worktree-create")return route.fallback();
      asked=true;await worktree.answered;listed.push(terminal("worktree-setup","Fixture setup",project.path));
      return json(route,{result:{worktree:project.path,setup:{scriptName:"Fixture setup",waitForSetup:false,session:{id:"worktree-setup"}}}});
    });
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"New task",exact:true}).click();
    await expect(header.locator(".thread-title-button.is-static")).toBeVisible();
    // The new task's short title leaves the row more room: the window narrows until the header folds actions into More actions.
    let width=1180;
    while(width>840&&!await more.isVisible()){width-=20;await page.setViewportSize({width,height:800});await settle(page)}
    await page.locator(".workspace-mode").selectOption("worktree");
    await composer.fill("Set up the worktree, then find the double counted refunds.");await page.getByTestId("send").click();
    await expect.poll(()=>asked,{message:"the send asked for its worktree"}).toBe(true);
    await expect(more).toBeVisible();await more.click();await expect(menu).toBeVisible();await expect(drawer).toHaveCount(0);
    worktree.release();
    await expectMoreActionsKept(page,{more,menu,drawer},"the setup terminal");
    await page.screenshot({path:join(shotsDir,"header-overflow-worktree-setup-terminal-dark-"+width+"x800.png"),animations:"disabled"});
    await menu.getByRole("button",{name:"Switch to light mode",exact:true}).click();await expect(page.locator("html")).toHaveAttribute("data-mode","light");
  }finally{await harness.close()}
});

// A harness's Sign in in Settings opens its sign-in terminal on the chat when the server answers, once it has started the harness's
// own sign in. More actions opened on the thread meanwhile stays open as that terminal comes up: the drawer asked for the keyboard as
// it opened, after the press that opened the menu, where it now asks as of the press on Sign in.
test("More actions opened on the thread while a harness's sign in starts stays open as its sign-in terminal comes up",async({page})=>{
  test.setTimeout(60_000);
  const {harness,thread,more,menu}=await openHeaderFixture(page,{width:1180,running:false});
  const drawer=page.getByTestId("drawer");
  try{
    const {listed,terminal,held,json}=await lateTerminals(page),signIn=held();
    await page.route(/\/api\/agent-runtimes$/,route=>route.request().method()!=="GET"?route.fallback():json(route,{
      selectedRuntime:"codex",selectedInstanceId:"codex-default",compatibleInstanceIds:["codex-default"],
      definitions:[{id:"codex",name:"Codex",protocol:"codex",multipleInstances:true,canAuthenticate:true}],
      instances:[{id:"codex-default",kind:"codex",displayName:"Codex",enabled:true}],
      statuses:[{id:"codex-default",kind:"codex",name:"Codex",available:true,installed:true,authenticated:false,version:"0.46.0",message:"Not signed in"}],
    }));
    await page.route(/\/api\/agent-runtime-auth$/,async route=>{await signIn.answered;const session=terminal("codex-sign-in","Codex sign in",process.cwd());listed.push(session);return json(route,{ok:true,authenticated:false,session})});
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"Settings",exact:true}).click();
    await page.getByRole("button",{name:/Agents & models/}).click();
    await page.locator(".agent-runtime-option").filter({hasText:"Codex"}).getByRole("button",{name:"Sign in",exact:true}).click();
    // Back on the thread while the sign in starts, More actions is opened.
    await openThread(page,thread.name);
    await more.click();await expect(menu).toBeVisible();await expect(drawer).toHaveCount(0);
    signIn.release();
    await expectMoreActionsKept(page,{more,menu,drawer},"the sign-in terminal");
    await page.screenshot({path:join(shotsDir,"header-overflow-sign-in-terminal-dark-1180x800.png"),animations:"disabled"});
    await menu.getByRole("button",{name:"Switch to light mode",exact:true}).click();await expect(page.locator("html")).toHaveAttribute("data-mode","light");
  }finally{await harness.close()}
});

// A turn's Stop button is one more control in the row. At 1280x800 with the 520px inspector the idle header has room for every
// action, so when a turn starts the row folds only what Stop displaces (an action or two, the actions still in the row stay put),
// and the turn ending gives them back. Before, the last fit level folded every action at once, so each turn moved six actions
// into the menu and back.
for(const mode of ["dark","light"])test(`a turn's Stop button folds only the header actions it displaces at 1280x800 with the 520px inspector in ${mode} mode`,async({page})=>{
  test.setTimeout(40_000);
  const {harness,thread,header,more}=await openHeaderFixture(page,{width:1280,mode,prCount:0,running:false});
  const clip=async()=>{const box=await header.boundingBox();return {x:box.x,y:0,width:box.width,height:box.y+box.height}};
  const shownActions=()=>header.locator(".workspace-header-actions>*").evaluateAll(nodes=>nodes.filter(node=>node.offsetParent).map(node=>node.getAttribute("aria-label")||node.getAttribute("title")||node.className));
  try{
    await page.mouse.move(500,420);
    const idle=await headerFold(header),idleShown=await shownActions();
    await expectFoldedOnlyAsNeeded(header,idle);
    await page.screenshot({path:join(shotsDir,`header-turn-idle-${mode}-1280x800.png`),animations:"disabled",clip:await clip()});
    await startTurn(page,header);
    // Stop moves at most two of the row's actions into the menu: the room it takes, and the More actions button's where the row
    // did not show it yet.
    const runningShown=await shownActions();
    expect(idleShown.filter(action=>!runningShown.includes(action)).length,`row before: ${idleShown.join(", ")}; while the turn runs: ${runningShown.join(", ")}`).toBeLessThanOrEqual(2);
    const running=await headerFold(header);
    await expectFoldedOnlyAsNeeded(header,running);
    // What was folded stays folded.
    expect(running.folded.slice(0,idle.folded.length)).toEqual(idle.folded);
    expect(await headerSeparators(header)).toEqual([await firstShownToggle(header)]);
    await expect(more).toBeVisible({visible:Number(running.fit)>=4});
    // The row's icon-only editor select shows its chevron alone, in either theme.
    expect(Number(running.fit)).toBeGreaterThanOrEqual(1);
    expect(await header.locator(".workspace-header-actions>.open-in-wrap select").evaluate(node=>getComputedStyle(node).color)).toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({path:join(shotsDir,`header-turn-running-${mode}-1280x800.png`),animations:"disabled",clip:await clip()});
    harness.push("turn/completed",{threadId:thread.id,turn:{id:"turn-live",status:"completed",completedAt:now()}});
    await expect(header.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0);await settle(page);
    expect(await shownActions()).toEqual(idleShown);
    expect((await headerFold(header)).folded).toEqual(idle.folded);
  }finally{await harness.close()}
});

// Folded into the More actions menu, Command palette shows the key it is on, as its button in the row names it.
for(const [width,mode] of [[1280,"dark"],[1280,"light"],[1180,"dark"],[1180,"light"]])test(`the More actions menu shows the key Command palette is on at ${width}x800 in ${mode} mode`,async({page})=>{
  const {harness,more,menu}=await openHeaderFixture(page,{width,mode,settings:{keybindingRules:[{command:"commandPalette",key:"Ctrl+Shift+K",when:""}]}});
  try{
    await more.click();
    await expect(menu.getByRole("button",{name:/^Command palette/}).locator("kbd")).toHaveText("Ctrl+Shift+K");
    await page.screenshot({path:join(shotsDir,`header-overflow-menu-palette-key-${mode}-${width}x800.png`),animations:"disabled"});
    await menu.getByRole("button",{name:/^Command palette/}).click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
  }finally{await harness.close()}
});

// A turn that ends while the More actions menu is open gives Stop's room back to the row, so the last action folded returns to
// it and leaves the menu, which stays open with the rest. Keyboard focus on that action's menu item moves to the menu's button
// instead of falling off the page. With one linked pull request, Stop is what keeps Open in folded at this size.
test("a turn ending while the More actions menu is open gives one action back to the row and keeps focus in the menu at 1180x800",async({page})=>{
  test.setTimeout(40_000);
  const {harness,thread,header,more,menu}=await openHeaderFixture(page,{width:1180,prCount:1});
  try{
    const running=await headerFold(header);
    expect(running.folded).toEqual(HEADER_FOLD_ORDER.slice(0,-1));
    await more.click();await expect(menu).toBeVisible();
    const openIn=menu.getByRole("button",{name:"Open",exact:true});
    await openIn.focus();await expect(openIn).toBeFocused();
    harness.push("turn/completed",{threadId:thread.id,turn:{id:"turn-live",status:"completed",completedAt:now()}});
    await expect(header.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0);await settle(page);
    const ended=await headerFold(header);
    await expectFoldedOnlyAsNeeded(header,ended);
    expect(ended.folded).toEqual(HEADER_FOLD_ORDER.slice(0,-2));
    await expect(menu).toBeVisible();await expect(openIn).toBeHidden();
    await expect(more).toBeFocused();
    await expect(menu.locator(":scope>button:visible").first()).toHaveText("Start the billing dev server");
    await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);await expect(more).toBeFocused();
  }finally{await harness.close()}
});

// When the row has room again for every action and for the theme and palette buttons, the More actions button hides, and the menu
// with it. Keyboard focus on an item goes with what it stood for to the row's own control: a folded action's, or the theme or
// palette button the row had set aside. Focus on the button itself goes to the control before the button. It never falls to the
// page. At 1280x800 a turn's end gives Stop's room back and the terminal it folded goes back to the row, but the goal stays folded
// and the theme and palette buttons in the menu, whose button takes room the row once kept by leaving them nowhere (UI lane C,
// 2026-10-21): focus on the terminal's item moves to the More button and the menu stays open. The window widened to 1600x800
// gives the row everything back.
for(const mode of ["dark","light"])test(`keyboard focus in the More actions menu goes with what it stood for to the row when a wider window gives the row everything back, and to the More button when a turn's end leaves the menu the goal and the theme and palette buttons, in ${mode} mode`,async({page})=>{
  test.setTimeout(60_000);
  const {harness,thread,header,more,menu}=await openHeaderFixture(page,{width:1280,mode,prCount:1});
  const themeLabel=mode==="dark"?"Switch to light mode":"Switch to dark mode",goal=header.getByRole("button",{name:"Thread goal",exact:true}),panelToggle=page.getByTestId("right-panel-toggle");
  const rowTheme=header.locator(".workspace-header-actions>.theme-toggle"),rowPalette=header.locator(".workspace-header-actions>.palette-control");
  // The window widens until the row holds everything again, and narrows back to 1280.
  const widen=async()=>{await page.setViewportSize({width:1600,height:800});await settle(page);expect((await headerFold(header)).folded).toEqual([]);await expect(more).toBeHidden();await expect(menu).toHaveCount(0)};
  const narrow=async()=>{await page.setViewportSize({width:1280,height:800});await settle(page);await expect(more).toBeVisible()};
  const openMenu=async()=>{await more.focus();await page.keyboard.press("Enter");await expect(menu).toBeVisible()};
  try{
    expect((await headerFold(header)).folded).toContain("terminal");
    await openMenu();await tabToMenuItem(page,menu,"Terminal");
    await endTurn(page,harness,thread,header);
    const ended=await headerFold(header);
    await expectFoldedOnlyAsNeeded(header,ended);expect(ended.folded).toEqual(["goal"]);
    await expect(menu).toBeVisible();await expect(more).toBeFocused();
    await expect(menu.locator(":scope>button:visible")).toHaveText(["Thread goal",themeLabel,/^Command palette/]);
    // The goal's item: the row's own goal button, and the next Tab goes on along the row.
    await tabToMenuItem(page,menu,"Thread goal");await widen();
    await expect(goal).toBeFocused();expect(await focusVisible(goal)).toBe(true);
    const box=await header.boundingBox();
    await page.screenshot({path:join(shotsDir,`header-unfold-focus-${mode}-1600x800.png`),animations:"disabled",clip:{x:box.x,y:0,width:box.width,height:box.y+box.height+8}});
    await page.keyboard.press("Tab");await expect(panelToggle).toBeFocused();
    // The More button itself, with its menu closed: the control before it.
    await narrow();await more.focus();await widen();
    await expect(rowPalette).toBeFocused();
    // The theme and palette items: the row's own theme and palette buttons.
    await narrow();await openMenu();await tabToMenuItem(page,menu,themeLabel);await widen();
    await expect(rowTheme).toBeFocused();expect(await focusVisible(rowTheme)).toBe(true);
    await narrow();await openMenu();await tabToMenuItem(page,menu,/^Command palette/);await widen();
    await expect(rowPalette).toBeFocused();
  }finally{await harness.close()}
});

// Wherever the header fits, it keeps a way to switch the theme and to open the command palette: the two buttons, or More actions
// holding them (UI lane C, 2026-10-21: at 700x800, the sidebar folded, "Repo task number one" took level 4, which sets the two
// buttons aside for the crumb's shortened name, while More actions showed only once actions folded, so nothing in the header
// switched the theme or opened the palette; a long title there kept both buttons). The short title and the long one at 1280,
// 1180, 900 and 700, with the sidebar open and closed and the docked inspector open and closed: at each the theme is switched from
// the header and back, and the palette opened from it. Then, beside the sidebar and the inspector, the window narrows 10px at a
// time through every level the header takes, each checked, with the theme and palette used from the header the first time at each
// and the title whole wherever a level shows it so, however many actions that folds.
for(const mode of ["dark","light"])test(`the header keeps a way to switch the theme and open the command palette at every fit level, for a short and a long title, with and without the sidebar and the inspector, in ${mode} mode`,async({page})=>{
  test.setTimeout(300_000);
  const short={id:"short-thread",name:"Repo task number one",preview:"Repo",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-120,updatedAt:now()-30,turns:[{id:"turn-s1",status:"completed",items:[{type:"userMessage",id:"user-s1",content:[{type:"text",text:"Tidy the repo task."}]},{type:"agentMessage",id:"assistant-s1",text:"Tidied."}]}]};
  const {harness,thread,header,more,menu}=await openHeaderFixture(page,{width:1280,mode,running:false,others:[short],otherPrs:2});
  const html=page.locator("html"),shell=page.locator(".app-shell"),right=page.getByTestId("right-panel"),palette=page.getByTestId("command-palette");
  const rowTheme=header.locator(".workspace-header-actions>.theme-toggle"),rowPalette=header.locator(".workspace-header-actions>.palette-control");
  const other=mode==="dark"?"light":"dark",levels=new Set();
  // The header's level, whether its theme and palette buttons or More actions show, and the title's box and its text's width, to
  // the fraction of a pixel, and whether Chrome cut it with its ellipsis.
  const read=()=>header.evaluate(node=>{
    const shown=selector=>Boolean(node.querySelector(selector)?.offsetParent),box=window.__titleBox(node.querySelector(".thread-title-button strong"));
    return {fit:node.dataset.fit,crumb:node.dataset.crumb||"",folded:[...node.querySelectorAll(".workspace-header-actions>[data-folded]")].map(control=>control.dataset.fold),theme:shown(".workspace-header-actions>.theme-toggle"),palette:shown(".workspace-header-actions>.palette-control"),more:shown(".header-overflow"),title:box.shown,whole:box.whole,cut:box.cut};
  });
  const setSidebar=async open=>{
    if(open!==(await shell.getAttribute("class")).includes("sidebar-collapsed"))return;
    if(open)await header.getByRole("button",{name:"Open sidebar",exact:true}).click();else await page.getByRole("button",{name:"Collapse sidebar",exact:true}).click();
    if(open)await expect(shell).not.toHaveClass(/sidebar-collapsed/);else await expect(shell).toHaveClass(/sidebar-collapsed/);
  };
  const setInspector=async open=>{
    if(open===await right.isVisible())return;
    await page.getByTestId("right-panel-toggle").click();await expect(right).toBeVisible({visible:open});
  };
  // The window at width with the sidebar and the docked inspector open or closed (at 900 and below the inspector lies over the
  // header), once the header has fitted the main column they leave.
  const at=async(width,sidebar,inspector)=>{
    if(width<=900)await setInspector(false);
    await page.setViewportSize({width,height:800});await setSidebar(sidebar);await setInspector(inspector);
    const column=width-(sidebar?(width<=900?196:width<=1120?224:258):0)-(inspector?520:0);
    await expect.poll(()=>header.evaluate(node=>Math.round(node.getBoundingClientRect().width)),{message:`the main column at ${width}px`}).toBe(column);await settle(page);
    const state=await read();levels.add(state.fit);return state;
  };
  // The title's width at the last level, which leaves it the most room (data-fit 6 with every action folded, the crumb keeping its
  // icon), read with the header set there for the moment and put back as it was.
  const titleAllFolded=()=>header.evaluate(node=>{
    const strong=node.querySelector(".thread-title-button strong"),fit=node.dataset.fit,crumb=node.dataset.crumb,marked=[...node.querySelectorAll("[data-fold]")];
    const folded=marked.filter(control=>control.hasAttribute("data-folded"));
    node.dataset.fit=marked.length?"6":"5";delete node.dataset.crumb;for(const control of marked)control.setAttribute("data-folded","");
    const box=window.__titleBox(strong);
    node.dataset.fit=fit;if(crumb)node.dataset.crumb=crumb;for(const control of marked)control.toggleAttribute("data-folded",folded.includes(control));
    return box;
  });
  const offers=(state,where,quiet)=>{
    const offered=Boolean(state.theme&&state.palette||state.more);
    if(!quiet)console.log(`header for ${where} in ${mode}: fit ${state.fit}${state.crumb?" crumb "+state.crumb:""}${state.folded.length?" folded "+state.folded.join(" "):""}, title ${state.title.toFixed(2)} of ${state.whole.toFixed(2)}px, ${state.theme&&state.palette?"theme and palette buttons":state.more?"More actions":"no theme or palette control"}`);
    expect.soft(offered,`the header for ${where} offers the theme and palette buttons or More actions (data-fit ${state.fit})`).toBe(true);
    return offered;
  };
  // The theme switched from the header and back, with its button or More actions' item, and the palette opened from the header.
  const use=async shot=>{
    for(const to of [other,mode]){
      const label="Switch to "+to+" mode";
      if((await read()).theme){if(shot&&to===other)await page.screenshot({path:shot,animations:"disabled"});await rowTheme.click()}
      else{
        await more.click();const item=menu.getByRole("button",{name:label,exact:true});await expect(item).toBeVisible();
        if(shot&&to===other)await page.screenshot({path:shot,animations:"disabled"});
        await item.click();
      }
      await expect(html).toHaveAttribute("data-mode",to);
    }
    if((await read()).palette)await rowPalette.click();else{await more.click();await menu.getByRole("button",{name:/^Command palette/}).click()}
    await expect(palette).toBeVisible();await page.keyboard.press("Escape");await expect(palette).toHaveCount(0);
  };
  try{
    for(const [name,slug] of [[short.name,"short"],[thread.name,"long"]]){
      await at(1280,true,false);await openThread(page,name);
      for(const [width,sidebar,inspector] of [[1280,true,false],[1280,true,true],[1280,false,true],[1280,false,false],[1180,false,false],[1180,false,true],[1180,true,true],[1180,true,false],[900,true,false],[900,false,false],[700,false,false],[700,true,false]]){
        const state=await at(width,sidebar,inspector),shot=join(shotsDir,`header-theme-palette-${slug}-${mode}-${width}x800${sidebar?"-sidebar":""}${inspector?"-inspector":""}.png`);
        if(offers(state,`"${name}" at ${width}x800${sidebar?" with the sidebar":""}${inspector?" with the inspector":""}`))await use(shot);
        else await page.screenshot({path:shot,animations:"disabled"});
      }
      // Beside the sidebar and the inspector, from 1600 to 1180, 10px at a time. The title shows whole wherever a level shows it
      // whole, which every action folded does if any does. (From about 1350 to 1420 the header stopped at the last level that folds
      // nothing, which cut "Repo task number one", and at 1360 the crumb's "Billi…" took 30px more of it, "Repo task n…".)
      const tried=new Set();
      for(let width=1600;width>=1180;width-=10){
        const state=await at(width,true,true),first=!tried.has(state.fit);tried.add(state.fit);
        if(offers(state,`"${name}" at ${width}x800 with the sidebar and the inspector`,!first)&&first)await use();
        const folded=await titleAllFolded();
        if(!folded.cut)expect.soft(state.cut,`"${name}" at ${width}x800 with the sidebar and the inspector shows whole, with no ellipsis, as it does with every action folded (${state.title.toFixed(2)} of ${state.whole.toFixed(2)}px at data-fit ${state.fit}${state.crumb?" crumb "+state.crumb:""}${state.folded.length?" folded "+state.folded.join(" "):""})`).toBe(false);
      }
    }
    // The levels that set the two buttons aside were all checked: 4, 5 (the chip's count too) and 6 (actions folded too).
    console.log(`levels the header took in ${mode}: ${[...levels].sort().join(" ")}`);
    for(const level of ["4","5","6"])expect([...levels],`the header took data-fit ${level}`).toContain(level);
  }finally{await harness.close()}
});

// The More actions menu with the keyboard. An item chosen with Enter or Space runs, the menu closes, and focus goes back to the
// More button, as Escape puts it. Shift+Tab from the first item goes back to the button. Focus that leaves the menu and its
// button (Tab past the last item, Shift+Tab from the button) closes the menu rather than leaving it open behind.
for(const mode of ["dark","light"])test(`a More actions item chosen with the keyboard leaves focus on the More button, and Tab out of the menu closes it, at 1180x800 in ${mode} mode`,async({page})=>{
  test.setTimeout(45_000);
  const {harness,header,more,menu}=await openHeaderFixture(page,{width:1180,mode});
  try{
    expect((await headerFold(header)).folded).toEqual(HEADER_FOLD_ORDER.slice(0,-1));
    await more.focus();await page.keyboard.press("Enter");await expect(menu).toBeVisible();
    await tabToMenuItem(page,menu,"Terminal");await page.keyboard.press("Enter");
    await expect(page.getByTestId("drawer")).toBeVisible();await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();expect(await focusVisible(more)).toBe(true);
    const box=await header.boundingBox();
    await page.screenshot({path:join(shotsDir,`header-overflow-keyboard-choose-${mode}-1180x800.png`),animations:"disabled",clip:{x:box.x,y:0,width:box.width,height:box.y+box.height+8}});
    // Space on the menu's Open does the same.
    await page.keyboard.press("Enter");await expect(menu).toBeVisible();
    await tabToMenuItem(page,menu,"Open");await page.keyboard.press("Space");
    await expect(menu).toHaveCount(0);await expect(more).toBeFocused();
    await expect.poll(()=>page.evaluate(()=>window.__opens)).toEqual(["vscode"]);
    // Shift+Tab from the first item goes back to the button, and the menu stays open.
    await page.keyboard.press("Enter");await expect(menu).toBeVisible();
    await page.keyboard.press("Tab");await expect(menu.getByRole("button",{name:"Open",exact:true})).toBeFocused();
    await page.keyboard.press("Shift+Tab");await expect(more).toBeFocused();await expect(menu).toBeVisible();
    // Tab past the last item closes the menu, and focus goes on to what follows the header.
    await tabToMenuItem(page,menu,/^Command palette/);await page.keyboard.press("Tab");
    await expect(menu).toHaveCount(0);await expect(more).toHaveAttribute("aria-expanded","false");
    expect(await page.evaluate(()=>{const node=document.activeElement;return node!==document.body&&!node.closest(".workspace-header")})).toBe(true);
    // Shift+Tab from the button closes it too.
    await more.focus();await page.keyboard.press("Enter");await expect(menu).toBeVisible();
    await page.keyboard.press("Shift+Tab");await expect(menu).toHaveCount(0);await expect(page.getByTestId("right-panel-toggle")).toBeFocused();
  }finally{await harness.close()}
});

// The command palette gives focus back to what opened it once it closes, so a keyboard user carries on from there: the More button
// it was chosen from, the header's own palette button, or the composer it was called up from with Ctrl+K.
for(const mode of ["dark","light"])test(`the command palette gives focus back to what opened it when it closes, in ${mode} mode`,async({page})=>{
  test.setTimeout(45_000);
  const {harness,header,more,menu}=await openHeaderFixture(page,{width:1180,mode,running:false,prCount:0});
  const palette=page.getByPlaceholder(/Search commands/i);
  const closePalette=async()=>{await expect(palette).toBeFocused();await page.keyboard.press("Escape");await expect(palette).toHaveCount(0)};
  try{
    // From the More actions menu, with the keyboard.
    await more.focus();await page.keyboard.press("Enter");await expect(menu).toBeVisible();
    await tabToMenuItem(page,menu,/^Command palette/);await page.keyboard.press("Enter");
    await closePalette();await expect(more).toBeFocused();expect(await focusVisible(more)).toBe(true);
    // From the header's own palette button, where the row has room for it.
    await page.getByTestId("right-panel-toggle").click();await page.setViewportSize({width:1600,height:980});await settle(page);
    const button=header.getByRole("button",{name:"Command palette",exact:true});await expect(button).toBeVisible();
    await button.focus();await page.keyboard.press("Enter");
    await closePalette();await expect(button).toBeFocused();
    // From the composer, with Ctrl+K.
    const composer=page.getByTestId("composer");await composer.focus();await page.keyboard.press("Control+K");
    await closePalette();await expect(composer).toBeFocused();
    await page.screenshot({path:join(shotsDir,`palette-closed-focus-${mode}-1600x980.png`),animations:"disabled"});
  }finally{await harness.close()}
});

// The More actions menu's Open-in picker is the header's own: an editor chosen in either is the one both open, Open closes the
// menu like its other actions, and a failed Open is reported once the menu has closed (the app's action error, as the menu's
// other actions report theirs) instead of over the menu's next items, in the shell's own sentence as the row's picker shows it,
// without a second "Could not open in" before it. The row's picker still shows its own failure beside it.
// A click inside the menu never slides the narrow main column sideways under the frame's glow.
for(const mode of ["dark","light"])test(`the More actions menu opens the editor the header's picker chose and reports a failed Open at 1180x800 in ${mode} mode`,async({page})=>{
  test.setTimeout(45_000);
  const {harness,header,more,menu}=await openHeaderFixture(page,{width:1180,mode,editors:[{id:"vscode",label:"Visual Studio Code"},{id:"cursor",label:"Cursor"}]});
  const preferred=()=>page.evaluate(()=>localStorage.getItem("trebell.preferredEditor"));
  const opens=()=>page.evaluate(()=>window.__opens);
  const frameScroll=()=>page.evaluate(()=>{const frame=document.querySelector(".main-frame");return frame.scrollLeft+frame.scrollTop});
  const rowPicker=header.locator(".workspace-header-actions>.open-in-wrap"),toast=page.getByTestId("app-action-error");
  const togglePanel=async()=>{await page.getByTestId("right-panel-toggle").click();await settle(page)};
  try{
    await expect(rowPicker).toBeHidden();
    await more.click();await expect(menu).toBeVisible();
    const select=menu.getByLabel("Choose external editor");
    await expect(select).toHaveValue("vscode");
    // Choosing an editor is a setting, not an action: the menu stays open. The header's own picker has the choice too.
    await select.selectOption("cursor");
    await expect(menu).toBeVisible();expect(await preferred()).toBe("cursor");
    await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
    await togglePanel();
    await expect.soft(rowPicker.getByLabel("Choose external editor"),"the row's picker after the menu chose Cursor").toHaveValue("cursor");
    await togglePanel();await expect(rowPicker).toBeHidden();
    // Open runs from the menu and closes it, without sliding the main column.
    await more.click();await expect(select).toHaveValue("cursor");
    const before=await header.boundingBox();
    await menu.getByRole("button",{name:"Open",exact:true}).click();
    expect.soft(await frameScroll(),"the main column's scroll after a click in the menu").toBe(0);expect.soft((await header.boundingBox()).x).toBe(before.x);
    await expect(menu).toHaveCount(0);
    await expect.poll(opens).toEqual(["cursor"]);
    // A failed Open: the menu has closed, the app names what failed, and nothing is left over the menu's items.
    await page.evaluate(()=>{window.__openFails=true});
    await more.click();await menu.getByRole("button",{name:"Open",exact:true}).click();
    await expect(menu).toHaveCount(0);
    await expect(toast).toHaveText(editorGone("Cursor","cursor"));
    await expect(page.locator(".open-in-error")).toHaveCount(0);
    expect(await frameScroll()).toBe(0);
    await page.screenshot({path:join(shotsDir,`header-overflow-open-failed-${mode}-1180x800.png`),animations:"disabled"});
    await more.click();await expect(menu).toBeVisible();
    const covered=await menu.locator(":scope>button:visible").evaluateAll(items=>items.filter(item=>{const box=item.getBoundingClientRect();return !item.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))}).map(item=>item.textContent));
    expect(covered).toEqual([]);
    await page.screenshot({path:join(shotsDir,`header-overflow-menu-after-failed-open-${mode}-1180x800.png`),animations:"disabled"});
    await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
    // Back in the row, the header's picker has the same editor, and its own failure shows beside it.
    await togglePanel();
    // Icon-only while the row is tight, the button is named by its tooltip.
    const rowOpen=rowPicker.locator(".open-in-picker>button");
    await expect(rowPicker).toBeVisible();await expect(rowPicker.getByLabel("Choose external editor")).toHaveValue("cursor");
    await expect(rowOpen).toHaveAttribute("title","Open in Cursor");
    await rowOpen.click();
    await expect(rowPicker.getByRole("alert")).toHaveText(editorGone("Cursor","cursor"));
    await page.evaluate(()=>{window.__openFails=false});
    await rowOpen.click();
    await expect(rowPicker.getByRole("alert")).toHaveCount(0);
    await expect.poll(opens).toEqual(["cursor","cursor","cursor","cursor"]);expect(await preferred()).toBe("cursor");
  }finally{await harness.close()}
});

// The row's Open-in picker shows its own failed Open beside it, and only until something replaces it: a later Open from the More
// actions menu (the row's copy stays mounted, hidden, while it is folded), whether that Open works or fails (the app reports a
// failure from the menu), another editor chosen in either copy, or another project.
for(const mode of ["dark","light"])test(`the row's Open-in picker drops its failure once a later Open, another editor or another project replaces it, at 1180x800 in ${mode} mode`,async({page})=>{
  test.setTimeout(60_000);
  const other={id:"other-thread",name:"Tidy the ledger export's logging",preview:"Logging",cwd:join(process.cwd(),"ui"),model:"fixture-model",status:{type:"idle"},createdAt:now()-120,updatedAt:now()-60,turns:[]};
  const {harness,thread,header,more,menu}=await openHeaderFixture(page,{width:1180,mode,running:false,editors:[{id:"vscode",label:"Visual Studio Code"},{id:"cursor",label:"Cursor"}],others:[other]});
  const opens=()=>page.evaluate(()=>window.__opens);
  const rowPicker=header.locator(".workspace-header-actions>.open-in-wrap"),rowAlert=rowPicker.getByRole("alert"),toast=page.getByTestId("app-action-error");
  const togglePanel=async()=>{await page.getByTestId("right-panel-toggle").click();await settle(page)};
  const failRowOpen=async(label="Visual Studio Code",id="vscode")=>{await page.evaluate(()=>{window.__openFails=true});await rowPicker.locator(".open-in-picker>button").click();await expect(rowAlert).toHaveText(editorGone(label,id))};
  const openFromMenu=async()=>{await more.click();await menu.getByRole("button",{name:"Open",exact:true}).click();await expect(menu).toHaveCount(0)};
  try{
    // The fixture opens the inspector, which folds the picker into the menu at this width; with it closed the picker is in the row.
    expect((await headerFold(header)).folded).toContain("open-in");
    await togglePanel();await expect(rowPicker).toBeVisible();
    await failRowOpen();
    // A later Open from the menu works, while a turn runs: the picker comes back to the row without the old failure.
    await togglePanel();await startTurn(page,header);
    await page.evaluate(()=>{window.__openFails=false});
    await openFromMenu();await expect.poll(opens).toEqual(["vscode","vscode"]);
    await endTurn(page,harness,thread,header);await togglePanel();
    await expect(rowPicker).toBeVisible();await expect(rowAlert).toHaveCount(0);
    await page.screenshot({path:join(shotsDir,`header-open-in-row-after-menu-open-${mode}-1180x800.png`),animations:"disabled"});
    // A later Open from the menu fails: the app names it, and the row does not show it again afterwards.
    await failRowOpen();
    await togglePanel();await openFromMenu();
    await expect(toast).toHaveText(editorGone("Visual Studio Code","vscode"));
    await togglePanel();await expect(rowPicker).toBeVisible();await expect(rowAlert).toHaveCount(0);
    // Another editor, chosen in the menu's copy.
    await failRowOpen();
    await togglePanel();await more.click();await menu.getByLabel("Choose external editor").selectOption("cursor");await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
    await togglePanel();await expect(rowPicker.getByLabel("Choose external editor")).toHaveValue("cursor");await expect(rowAlert).toHaveCount(0);
    // Another project, and the first one again.
    await failRowOpen("Cursor","cursor");
    await openThread(page,other.name);await expect(rowPicker).toBeVisible();await expect(rowAlert).toHaveCount(0);
    const box=await header.boundingBox();
    await page.screenshot({path:join(shotsDir,`header-open-in-row-other-project-${mode}-1180x800.png`),animations:"disabled",clip:{x:box.x,y:0,width:box.width,height:box.y+box.height+60}});
    await openThread(page,thread.name);await expect(rowPicker).toBeVisible();await expect(rowAlert).toHaveCount(0);
    // An Open that fails only after another project has opened is not kept for the first one either.
    await page.evaluate(()=>{window.__openHold=new Promise(resolve=>{window.__releaseOpen=resolve})});
    const rowOpen=rowPicker.locator(".open-in-picker>button");
    await rowOpen.click();await expect(rowOpen).toHaveText("Opening…");
    await openThread(page,other.name);await page.evaluate(()=>window.__releaseOpen());
    await expect(rowOpen).toHaveText("Open");await expect(rowAlert).toHaveCount(0);
    await openThread(page,thread.name);await expect(rowPicker).toBeVisible();await expect(rowAlert).toHaveCount(0);
    expect(await opens()).toEqual(["vscode","vscode","vscode","vscode","vscode","cursor","cursor"]);
  }finally{await harness.close()}
});

// The inspector opens over the spot where its header toggle was clicked, so the pointer comes to rest on one of the tab strip's
// last tabs (Runtime, at 1280px with the 520px inspector). That tab is hovered, and the reference design fills a hovered tab; the
// selected look is the accent underline. While the panel still loads, as after, only the tab being opened is underlined, the
// hovered tab alone is filled, and no tab is once the pointer moves off.
for(const mode of ["dark","light"])test(`while the inspector's panel loads only the tab being opened looks selected, in ${mode} mode`,async({page})=>{
  test.setTimeout(35_000);
  const project={id:"tabs-project",name:"Billing reconciliation service",path:process.cwd(),environmentId:null,branch:"main"};
  const thread={id:"tabs-thread",name:"Check the inspector tabs while the panel loads",preview:"Tabs",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[]};
  const harness=await startHarness([thread]);
  // The Files panel's code is held, so the inspector says "Loading panel…" until the test lets it load.
  let releasePanel=()=>{};const panelHeld=new Promise(resolve=>{releasePanel=resolve});
  await page.route(/\/assets\/WorkspacePanel-[^/]+\.js$/,async route=>{await panelHeld;await route.fallback()});
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:false,environmentId:null}},project,settings:{appearanceMode:mode},layout:{sidebarWidth:258,rightPanelWidth:520,terminalHeight:330}});
    await openThread(page,thread.name);
    await page.getByTestId("right-panel-toggle").click();
    const panel=page.getByTestId("right-panel"),tabs=panel.locator(".context-panel-tab");
    await expect(panel.getByRole("status")).toHaveText("Loading panel…");
    const looks=()=>tabs.evaluateAll(nodes=>nodes.map(node=>({tab:node.getAttribute("aria-label"),hovered:node.matches(":hover"),filled:getComputedStyle(node).backgroundColor!=="rgba(0, 0, 0, 0)",underlined:getComputedStyle(node,"::after").backgroundColor!=="rgba(0, 0, 0, 0)"})));
    const named=(list,key)=>list.filter(item=>item[key]).map(item=>item.tab);
    await expect(tabs.filter({hasText:"Files"})).toHaveClass(/\bactive\b/);
    const state=async()=>{const list=await looks();return {filled:named(list,"filled"),hovered:named(list,"hovered"),underlined:named(list,"underlined")}};
    // With the pointer on Runtime, as it rests after the click: Runtime is filled because it is hovered, and Files alone is underlined.
    await panel.getByRole("button",{name:"Runtime",exact:true}).hover();
    await expect.poll(state).toEqual({filled:["Runtime"],hovered:["Runtime"],underlined:["Files"]});
    await page.screenshot({path:join(shotsDir,`inspector-tabs-loading-pointer-${mode}-1280x800.png`),animations:"disabled"});
    // Moved off the strip, no tab is filled; Files alone looks selected.
    await page.mouse.move(400,420);
    await expect.poll(state).toEqual({filled:[],hovered:[],underlined:["Files"]});
    await expect(panel.getByRole("status")).toHaveText("Loading panel…");
    await page.screenshot({path:join(shotsDir,`inspector-tabs-loading-${mode}-1280x800.png`),animations:"disabled"});
    // Once the panel loads, the strip looks the same.
    releasePanel();
    await expect(panel.getByRole("status")).toHaveCount(0);
    await expect.poll(state).toEqual({filled:[],hovered:[],underlined:["Files"]});
  }finally{releasePanel();await harness.close()}
});

test("while a search filters the sidebar, Move up and Move down follow the threads it shows, in the list's order",async({page})=>{
  test.setTimeout(35_000);
  const base={cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[]};
  // A relay harness (Claude Code here) lists each thread with its place among the threads outside a section.
  const threads=[{...base,id:"gamma-zero",name:"Gamma zero",preview:"G0"},{...base,id:"alpha-one",name:"Alpha one",preview:"A1"},{...base,id:"beta-two",name:"Beta two",preview:"B2"},{...base,id:"alpha-three",name:"Alpha three",preview:"A3"}].map((thread,index)=>({...thread,sectionRank:index}));
  const meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}]));
  // Gamma zero matches "alpha" in a message only, so the search finds it after the title matches.
  const harness=await startHarness(threads,{respond:message=>message.method==="thread/items/list"?{data:message.params?.threadId==="gamma-zero"?[{type:"userMessage",text:"Compare this with the alpha release."}]:[],nextCursor:null}:undefined});
  try{
    await openApp(page,{harness,threads,meta,runtime:"claude"});
    await expect(threadRow(page,"Alpha three")).toBeVisible();
    const search=page.getByRole("textbox",{name:"Search threads"});
    const shown=()=>page.locator(".thread-sections section").evaluateAll(sections=>sections.map(section=>[section.querySelector("h4").firstChild.textContent,[...section.querySelectorAll(".thread-main")].map(node=>node.title)]));
    const menu=async name=>{const row=threadRow(page,name);await row.hover();await row.locator(".thread-menu summary").click();return row};
    const moves=async name=>{
      const row=await menu(name);const state=[await row.getByRole("button",{name:"Move up",exact:true}).isEnabled(),await row.getByRole("button",{name:"Move down",exact:true}).isEnabled()];
      await row.locator(".thread-menu summary").click();await expect(row.locator(".thread-menu")).not.toHaveAttribute("open","");
      return state;
    };
    const moveRequests=()=>harness.requests.filter(request=>request.method==="thread/section/move").map(request=>request.params);
    // A thread alone among the results has nowhere to move.
    await search.fill("beta");
    await expect.poll(shown).toEqual([["Active",["Beta two"]]]);
    const lone=await menu("Beta two");
    await expect(lone.getByRole("button",{name:"Move up",exact:true})).toBeDisabled();
    await expect(lone.getByRole("button",{name:"Move down",exact:true})).toBeDisabled();
    await page.screenshot({path:join(shotsDir,"sidebar-search-lone-thread-1600x980.png"),animations:"disabled"});
    await lone.locator(".thread-menu summary").click();await expect(lone.locator(".thread-menu")).not.toHaveAttribute("open","");
    // The results keep the list's order (the message match Gamma zero first, as in the list), and the moves follow them.
    await search.fill("alpha");
    await expect.poll(shown).toEqual([["Active",["Gamma zero","Alpha one","Alpha three"]]]);
    expect(await moves("Gamma zero")).toEqual([false,true]);
    expect(await moves("Alpha one")).toEqual([true,true]);
    expect(await moves("Alpha three")).toEqual([true,false]);
    // Alpha one moves down past Alpha three, the next result: it goes right after it in the list (the end), past the hidden Beta two. The
    // move shows at once; this harness keeps its own order whatever it is told, so the sidebar then reads that order back.
    const unmoved=[["Active",["Gamma zero","Alpha one","Alpha three"]]];
    await (await menu("Alpha one")).getByRole("button",{name:"Move down",exact:true}).click();
    await expect.poll(moveRequests).toEqual([{threadId:"alpha-one",sectionId:null,beforeThreadId:null}]);
    await expect.poll(shown).toEqual(unmoved);
    // Alpha three moves up past Alpha one, the result above it, not past the hidden Beta two next to it in the list.
    await (await menu("Alpha three")).getByRole("button",{name:"Move up",exact:true}).click();
    await expect.poll(()=>moveRequests().at(-1)).toEqual({threadId:"alpha-three",sectionId:null,beforeThreadId:"alpha-one"});
    await expect.poll(shown).toEqual(unmoved);
    // Gamma zero moves down past Alpha one: right before the hidden Beta two, which keeps its place.
    await (await menu("Gamma zero")).getByRole("button",{name:"Move down",exact:true}).click();
    await expect.poll(()=>moveRequests().at(-1)).toEqual({threadId:"gamma-zero",sectionId:null,beforeThreadId:"beta-two"});
    await page.screenshot({path:join(shotsDir,"sidebar-search-moves-1600x980.png"),animations:"disabled"});
  }finally{await harness.close()}
});

test("Move up and Move down reorder a relay harness's threads, and the order survives a reload and a relay restart",async({page})=>{
  test.setTimeout(60_000);
  const home=await mkdtemp(join(tmpdir(),"trebell-relay-order-"));let relay=await startRelay(home);
  // Newest first, a minute apart: the order the sidebar shows before anyone moves a thread.
  const base=Math.floor(Date.now()/1000),names=["Relay order one","Relay order two","Relay order three","Relay order four"];
  const ids=names.map((name,index)=>relay.threadStore.importHistory({runtime:"native",cwd:process.cwd(),providerSessionId:"relay-order-"+index,model:"fixture-model",name,preview:name,createdAt:base-600-index*60,updatedAt:base-index*60}).id);
  const meta=Object.fromEntries(ids.map(id=>[id,{projectless:false,environmentId:null,runtime:"native"}]));
  const harness={get wsUrl(){return relay.wsUrl}};
  const menu=async name=>{const row=threadRow(page,name);await row.hover();await row.locator(".thread-menu summary").click();return row};
  const move=async(name,label)=>(await menu(name)).getByRole("button",{name:label,exact:true}).click();
  try{
    await openApp(page,{harness,threads:[],meta,runtime:"native"});
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",names]]);
    // Down puts the thread after the next one, up before the previous one; the threads nobody moved keep their order.
    await move("Relay order one","Move down");
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",["Relay order two","Relay order one","Relay order three","Relay order four"]]]);
    await move("Relay order four","Move up");
    const moved=[["Active",["Relay order two","Relay order one","Relay order four","Relay order three"]]];
    await expect.poll(()=>sidebarGroups(page)).toEqual(moved);
    await page.screenshot({path:join(shotsDir,"sidebar-relay-moves-1600x980.png"),animations:"disabled"});
    // A move is not activity: the moved threads keep their last-update times.
    expect(relay.threadStore.list("native").map(thread=>[thread.name,thread.updatedAt])).toEqual(names.map((name,index)=>[name,base-index*60]));
    await page.reload();
    await expect.poll(()=>sidebarGroups(page)).toEqual(moved);
    // A pinned thread takes its place in Pinned by recent activity (Relay order one is the newer, and its place in Active does not come
    // along), and a move within Pinned stays there.
    await (await menu("Relay order three")).getByRole("button",{name:"Pin",exact:true}).click();
    await (await menu("Relay order one")).getByRole("button",{name:"Pin",exact:true}).click();
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Relay order one","Relay order three"]],["Active",["Relay order two","Relay order four"]]]);
    await move("Relay order one","Move down");
    const pinned=[["Pinned",["Relay order three","Relay order one"]],["Active",["Relay order two","Relay order four"]]];
    await expect.poll(()=>sidebarGroups(page)).toEqual(pinned);
    // A restarted relay reads the same order from its thread store.
    await relay.close();relay=await startRelay(home);
    await page.reload();
    await expect.poll(()=>sidebarGroups(page)).toEqual(pinned);
    await page.screenshot({path:join(shotsDir,"sidebar-relay-moves-after-restart-1600x980.png"),animations:"disabled"});
  }finally{await relay.close();await rm(home,{recursive:true,force:true}).catch(()=>{})}
});

test("on Codex a section shows by recent activity until a person orders it, then in Codex's own order, and moves nothing Codex cannot order",async({page})=>{
  test.setTimeout(60_000);
  const sections=[{id:"0198-pinned",name:"Pinned",appearance:null},{id:"0198-snoozed",name:"Snoozed",appearance:null},{id:"0198-settled",name:"Settled",appearance:null},{id:"0199-research",name:"Research",appearance:null}];
  const base={cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-900,turns:[]},section=id=>sections.find(item=>item.id===id);
  // Codex's Pinned order is alpha, beta, gamma: the order they were pinned (Codex adds a thread with no thread to go before at the end of
  // a section), not their last updates (gamma is the newest). The sidebar has always shown Pinned by recent activity.
  const threads=[
    {...base,id:"pinned-alpha",name:"Pinned alpha",updatedAt:now()-300,section:section("0198-pinned")},
    {...base,id:"pinned-beta",name:"Pinned beta",updatedAt:now()-200,section:section("0198-pinned")},
    {...base,id:"pinned-gamma",name:"Pinned gamma",updatedAt:now()-100,section:section("0198-pinned")},
    {...base,id:"active-one",name:"Codex active one",updatedAt:now()-10,section:null},
    {...base,id:"active-two",name:"Codex active two",updatedAt:now()-20,section:null},
    {...base,id:"research-notes",name:"Research notes",updatedAt:now()-50,section:section("0199-research")},
  ];
  const meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}]));
  const harness=await startCodexHarness(threads,sections);
  const menu=async name=>{const row=threadRow(page,name);await row.hover();await row.locator(".thread-menu summary").click();return row};
  const close=async row=>{await row.locator(".thread-menu summary").click();await expect(row.locator(".thread-menu")).not.toHaveAttribute("open","")};
  const move=async(name,label)=>(await menu(name)).getByRole("button",{name:label,exact:true}).click();
  const moves=()=>harness.requests.filter(request=>request.method==="thread/section/move").map(request=>request.params);
  const order=id=>harness.order.get(id);
  try{
    await openApp(page,{harness,threads,meta});
    // Nobody has ordered Pinned in Trebell, so it shows by recent activity as it always has (not Codex's order of entry). The thread in
    // the Research section (made in another Codex client) has a group of its own instead of vanishing.
    const unordered=[["Pinned",["Pinned gamma","Pinned beta","Pinned alpha"]],["Active",["Codex active one","Codex active two"]],["Research",["Research notes"]]];
    await expect.poll(()=>sidebarGroups(page)).toEqual(unordered);
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value;document.documentElement.style.colorScheme=value},mode);
      await page.screenshot({path:join(shotsDir,`sidebar-codex-sections-${mode}-1600x980.png`),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
    }
    await page.evaluate(()=>{document.documentElement.dataset.mode="dark";document.documentElement.style.colorScheme="dark"});
    // Codex orders the threads outside a section by recent activity only, so they cannot be moved, and the menu says why.
    const active=await menu("Codex active one");
    for(const label of ["Move up","Move down"]){const item=active.getByRole("button",{name:label,exact:true});await expect(item).toBeDisabled();await expect(item).toHaveAttribute("title","This list is kept in order of recent activity")}
    await close(active);
    const research=await menu("Research notes");
    await expect(research.getByRole("button",{name:"Move up",exact:true})).toBeDisabled();await expect(research.getByRole("button",{name:"Move down",exact:true})).toBeDisabled();
    await expect(research.getByRole("button",{name:"Move up",exact:true})).not.toHaveAttribute("title",/./);
    await close(research);
    // The first move in Pinned writes the order the sidebar shows into Codex, with the move made (here alpha only has to go to the end),
    // and saves Pinned as ordered.
    await move("Pinned beta","Move up");
    await expect.poll(moves).toEqual([{threadId:"pinned-alpha",sectionId:"0198-pinned",beforeThreadId:null}]);
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Pinned beta","Pinned gamma","Pinned alpha"]],["Active",["Codex active one","Codex active two"]],["Research",["Research notes"]]]);
    expect(order("0198-pinned")).toEqual(["pinned-beta","pinned-gamma","pinned-alpha"]);
    // From then on a move is Codex's own: before the thread after the next one.
    await move("Pinned beta","Move down");
    await expect.poll(()=>moves().at(-1)).toEqual({threadId:"pinned-beta",sectionId:"0198-pinned",beforeThreadId:"pinned-alpha"});
    const reordered=[["Pinned",["Pinned gamma","Pinned beta","Pinned alpha"]],["Active",["Codex active one","Codex active two"]],["Research",["Research notes"]]];
    await expect.poll(()=>sidebarGroups(page)).toEqual(reordered);
    expect(order("0198-pinned")).toEqual(["pinned-gamma","pinned-beta","pinned-alpha"]);
    // Ordered by hand, Pinned keeps that order through a reload, and through activity in a thread lower down.
    threads.find(thread=>thread.id==="pinned-alpha").updatedAt=now();
    await page.reload();
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Pinned gamma","Pinned beta","Pinned alpha"]],["Active",["Codex active one","Codex active two"]],["Research",["Research notes"]]]);
    await page.screenshot({path:join(shotsDir,"sidebar-codex-pinned-moves-1600x980.png"),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
    // In a section ordered by hand a pinned thread goes first; its undo sends it back without a thread to go before (Codex refuses one
    // outside a section).
    await move("Codex active two","Pin");
    await expect.poll(()=>moves().at(-1)).toEqual({threadId:"active-two",sectionId:"0198-pinned",beforeThreadId:"pinned-gamma"});
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Codex active two","Pinned gamma","Pinned beta","Pinned alpha"]],["Active",["Codex active one"]],["Research",["Research notes"]]]);
    await page.getByTestId("thread-undo-toast").getByRole("button",{name:"Undo",exact:true}).click();
    await expect.poll(()=>moves().at(-1)).toEqual({threadId:"active-two",sectionId:null,beforeThreadId:null});
    await expect.poll(()=>sidebarGroups(page)).toEqual(reordered);
    // Unpinned and pinned again, a thread of Pinned goes back to its place there: before the thread that followed it.
    await move("Pinned beta","Unpin");
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Pinned gamma","Pinned alpha"]],["Active",["Codex active one","Codex active two","Pinned beta"]],["Research",["Research notes"]]]);
    await page.getByTestId("thread-undo-toast").getByRole("button",{name:"Undo",exact:true}).click();
    await expect.poll(()=>moves().at(-1)).toEqual({threadId:"pinned-beta",sectionId:"0198-pinned",beforeThreadId:"pinned-alpha"});
    await expect.poll(()=>sidebarGroups(page)).toEqual(reordered);
    await expect(page.getByText(/Could not put back/)).toHaveCount(0);
  }finally{await harness.close()}
});

test("on Codex a section nobody ordered keeps its order by recent activity, and a newly pinned thread lands where its activity puts it",async({page})=>{
  test.setTimeout(45_000);
  const sections=[{id:"0198-pinned",name:"Pinned",appearance:null},{id:"0198-snoozed",name:"Snoozed",appearance:null},{id:"0198-settled",name:"Settled",appearance:null}];
  const base={cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-9000,turns:[]},pinned=sections[0];
  // Pinned in this order (Codex keeps it: each was added at the end): the first long ago, the last recently; the last is in daily use.
  const threads=[
    {...base,id:"first-pinned",name:"First pinned (stale)",updatedAt:now()-7200,section:pinned},
    {...base,id:"second-pinned",name:"Second pinned",updatedAt:now()-3600,section:pinned},
    {...base,id:"third-pinned",name:"Last pinned (in daily use)",updatedAt:now()-60,section:pinned},
    {...base,id:"to-pin",name:"Thread pinned now",updatedAt:now()-30,section:null},
    {...base,id:"older-active",name:"An older active thread",updatedAt:now()-5000,section:null},
  ];
  const meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}]));
  const harness=await startCodexHarness(threads,sections);
  const menu=async name=>{const row=threadRow(page,name);await row.hover();await row.locator(".thread-menu summary").click();return row};
  const moves=()=>harness.requests.filter(request=>request.method==="thread/section/move").map(request=>request.params);
  try{
    await openApp(page,{harness,threads,meta});
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Last pinned (in daily use)","Second pinned","First pinned (stale)"]],["Active",["Thread pinned now","An older active thread"]]]);
    // A new pin is added as Codex adds one (at the end of its order) and shows where its activity puts it; so does an older one.
    await (await menu("Thread pinned now")).getByRole("button",{name:"Pin",exact:true}).click();
    await expect.poll(moves).toEqual([{threadId:"to-pin",sectionId:"0198-pinned",beforeThreadId:null}]);
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Thread pinned now","Last pinned (in daily use)","Second pinned","First pinned (stale)"]],["Active",["An older active thread"]]]);
    await (await menu("An older active thread")).getByRole("button",{name:"Pin",exact:true}).click();
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Thread pinned now","Last pinned (in daily use)","Second pinned","An older active thread","First pinned (stale)"]]]);
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value;document.documentElement.style.colorScheme=value},mode);
      await page.screenshot({path:join(shotsDir,`sidebar-codex-unordered-pins-${mode}-1600x980.png`),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
    }
    // Activity still lifts a pinned thread nobody moved.
    threads.find(thread=>thread.id==="first-pinned").updatedAt=now();
    await page.reload();
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["First pinned (stale)","Thread pinned now","Last pinned (in daily use)","Second pinned","An older active thread"]]]);
    expect(harness.requests.some(request=>request.method==="thread/list"&&request.params?.sortKey==="section_position")).toBe(false);
  }finally{await harness.close()}
});

test("on Codex a section whose order cannot be read still shows its threads, and only its Move items say so: the list did load",async({page})=>{
  test.setTimeout(45_000);
  const sections=[{id:"0198-pinned",name:"Pinned",appearance:null},{id:"0198-snoozed",name:"Snoozed",appearance:null},{id:"0198-settled",name:"Settled",appearance:null},{id:"0199-research",name:"Research",appearance:null}];
  const base={cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-900,turns:[]},section=id=>sections.find(item=>item.id===id);
  // Pinned and Research were ordered by hand. Codex's Pinned order is alpha, then beta (beta is the newer one); Research's order cannot
  // be read.
  const threads=[
    {...base,id:"pinned-alpha",name:"Pinned alpha",updatedAt:now()-300,section:section("0198-pinned")},
    {...base,id:"pinned-beta",name:"Pinned beta",updatedAt:now()-200,section:section("0198-pinned")},
    {...base,id:"active-one",name:"Codex active one",updatedAt:now()-10,section:null},
    {...base,id:"research-one",name:"Research one",updatedAt:now()-60,section:section("0199-research")},
    {...base,id:"research-two",name:"Research two",updatedAt:now()-40,section:section("0199-research")},
  ];
  const meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}]));
  const harness=await startCodexHarness(threads,sections,{failOrder:["0199-research"]});
  try{
    await openApp(page,{harness,threads,meta,settings:{orderedThreadSections:["0198-pinned","0199-research"]}});
    // Research's threads stay listed (newest first, as listed) and Pinned keeps Codex's order. The list loaded, so nothing says it failed.
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Pinned alpha","Pinned beta"]],["Active",["Codex active one"]],["Research",["Research two","Research one"]]]);
    await expect(page.locator(".sidebar-list-error")).toHaveCount(0);await expect(page.getByText(/Could not refresh threads/)).toHaveCount(0);
    // With no order, Research's threads cannot move, and their Move items name the order that could not be read.
    const row=threadRow(page,"Research two");await row.hover();await row.locator(".thread-menu summary").click();
    for(const label of ["Move up","Move down"]){const item=row.getByRole("button",{name:label,exact:true});await expect(item).toBeDisabled();await expect(item).toHaveAttribute("title","Could not read the order of Research: section order unavailable")}
    await page.screenshot({path:join(shotsDir,"sidebar-codex-section-order-failed-1600x980.png"),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
    await row.locator(".thread-menu summary").click();await expect(row.locator(".thread-menu")).not.toHaveAttribute("open","");
    // A turn that completes reloads the list; the unreadable order is not reported as a failed refresh either.
    await openThread(page,"Codex active one");
    harness.push("turn/started",{threadId:"active-one",turn:{id:"turn-x",status:"inProgress",items:[]}});
    harness.push("turn/completed",{threadId:"active-one",turn:{id:"turn-x",status:"completed",items:[],durationMs:1200}});
    await expect.poll(()=>harness.requests.filter(request=>request.method==="thread/list"&&request.params?.sectionId==="0199-research").length).toBeGreaterThan(1);
    await settle(page);
    await expect(page.getByText(/could not refresh/i)).toHaveCount(0);await expect(page.locator(".sidebar-list-error")).toHaveCount(0);
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Pinned alpha","Pinned beta"]],["Active",["Codex active one"]],["Research",["Research two","Research one"]]]);
  }finally{await harness.close()}
});

test("on a relay harness a thread pinned or settled and then un-done still rises with its activity, as every thread nobody moved does",async({page})=>{
  test.setTimeout(45_000);
  const home=await mkdtemp(join(tmpdir(),"trebell-relay-undo-"));const relay=await startRelay(home);
  const base=Math.floor(Date.now()/1000)-3600,names=["Relay one","Relay two","Relay three","Relay four"];
  const ids=names.map((name,index)=>relay.threadStore.importHistory({runtime:"native",cwd:process.cwd(),providerSessionId:"relay-undo-"+index,model:"fixture-model",name,preview:name,createdAt:base-600,updatedAt:base-index*60}).id);
  const meta=Object.fromEntries(ids.map(id=>[id,{projectless:false,environmentId:null,runtime:"native"}]));
  const menu=async name=>{const row=threadRow(page,name);await row.hover();await row.locator(".thread-menu summary").click();return row};
  const undo=()=>page.getByTestId("thread-undo-toast").getByRole("button",{name:"Undo",exact:true}).click();
  try{
    await openApp(page,{harness:relay,threads:[],meta,runtime:"native"});
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",names]]);
    await (await menu("Relay two")).getByRole("button",{name:"Pin",exact:true}).click();
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Relay two"]],["Active",["Relay one","Relay three","Relay four"]]]);
    await undo();await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",names]]);
    await (await menu("Relay three")).getByRole("button",{name:"Settle",exact:true}).click();
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",["Relay one","Relay two","Relay four"]],["Settled",["Relay three"]]]);
    await undo();await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",names]]);
    // Nobody moved them, so the relay keeps no place for them.
    expect(relay.threadStore.list("native").map(thread=>[thread.name,thread.sectionPosition??null])).toEqual(names.map(name=>[name,null]));
    // New activity in Relay four, then in Relay two: each rises to the top.
    relay.threadStore.update(ids[3],{updatedAt:base+100},{touch:false});await page.reload();
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",["Relay four","Relay one","Relay two","Relay three"]]]);
    relay.threadStore.update(ids[1],{updatedAt:base+200},{touch:false});await page.reload();
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",["Relay two","Relay four","Relay one","Relay three"]]]);
    await page.screenshot({path:join(shotsDir,"sidebar-relay-undo-then-activity-1600x980.png"),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
  }finally{await relay.close();await rm(home,{recursive:true,force:true}).catch(()=>{})}
});

test("on a relay harness a search finds a thread beyond the sidebar's first page as it is, with its place, and moves it",async({page})=>{
  test.setTimeout(45_000);
  const home=await mkdtemp(join(tmpdir(),"trebell-relay-search-"));const relay=await startRelay(home);
  // 104 threads, a minute apart: the sidebar lists the newest 100, and Trebell's saved data knows the rest only by id.
  const base=Math.floor(Date.now()/1000)-3600,ids=[];
  for(let index=0;index<104;index++)ids.push(relay.threadStore.importHistory({runtime:"native",cwd:process.cwd(),providerSessionId:"relay-many-"+index,model:"fixture-model",name:index===103?"Needle oldest thread":index===102?"Needle second oldest":"Bulk thread "+String(index).padStart(3,"0"),createdAt:base-9000,updatedAt:base-index*60}).id);
  const meta=Object.fromEntries(ids.map(id=>[id,{projectless:false,environmentId:null,runtime:"native"}]));
  try{
    await openApp(page,{harness:relay,threads:[],meta,runtime:"native"});
    await expect(threadRow(page,"Bulk thread 000")).toBeVisible();
    await page.getByRole("textbox",{name:"Search threads"}).fill("Needle");
    await expect.poll(()=>sidebarGroups(page),{timeout:10_000}).toEqual([["Active",["Needle second oldest","Needle oldest thread"]]]);
    const row=threadRow(page,"Needle second oldest");
    await expect(row.locator(".thread-main > div > span")).toHaveText(/^fixture-model · /);await expect(row.locator(".thread-main > div > span")).not.toHaveText(/now$/);
    await row.hover();await row.locator(".thread-menu summary").click();
    await expect(row.getByRole("button",{name:"Move up",exact:true})).toBeDisabled();
    const down=row.getByRole("button",{name:"Move down",exact:true});await expect(down).toBeEnabled();await expect(down).not.toHaveAttribute("title",/./);
    await page.screenshot({path:join(shotsDir,"sidebar-relay-search-beyond-first-page-1600x980.png"),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
    await down.click();
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",["Needle oldest thread","Needle second oldest"]]]);
    expect(Number.isFinite(relay.threadStore.getMetadata(ids[102]).sectionPosition)).toBe(true);
  }finally{await relay.close();await rm(home,{recursive:true,force:true}).catch(()=>{})}
});

test("on Codex a search finds a thread of a section beyond the sidebar's first page as it is, with a place there, and moves it",async({page})=>{
  test.setTimeout(45_000);
  const sections=[{id:"0198-pinned",name:"Pinned",appearance:null},{id:"0198-snoozed",name:"Snoozed",appearance:null},{id:"0198-settled",name:"Settled",appearance:null}];
  const base={cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-90000,turns:[]},pinned=sections[0];
  // 104 threads a minute apart: the sidebar lists the newest 100 (the two newest are pinned), and Trebell's saved data knows the rest
  // only by id. The two oldest, beyond that page, are pinned too; Codex's Pinned order is the order they were pinned.
  const threads=Array.from({length:104},(_,index)=>({...base,id:"codex-many-"+index,name:index===103?"Needle oldest thread":index===102?"Needle second oldest":index<2?"Pinned recent "+index:"Bulk thread "+String(index).padStart(3,"0"),updatedAt:now()-3600-index*60,section:index<2||index>=102?pinned:null}));
  const meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}]));
  const harness=await startCodexHarness(threads,sections);
  const moves=()=>harness.requests.filter(request=>request.method==="thread/section/move").map(request=>request.params);
  const menu=async name=>{const row=threadRow(page,name);await row.hover();await row.locator(".thread-menu summary").click();return row};
  try{
    await openApp(page,{harness,threads,meta});
    await expect(threadRow(page,"Bulk thread 002")).toBeVisible();
    await page.getByRole("textbox",{name:"Search threads"}).fill("Needle");
    await expect.poll(()=>sidebarGroups(page),{timeout:10_000}).toEqual([["Pinned",["Needle second oldest","Needle oldest thread"]]]);
    const row=threadRow(page,"Needle second oldest");
    await expect(row.locator(".thread-main > div > span")).toHaveText(/^fixture-model · /);await expect(row.locator(".thread-main > div > span")).not.toHaveText(/now$/);
    await row.hover();await row.locator(".thread-menu summary").click();
    await expect(row.getByRole("button",{name:"Move up",exact:true})).toBeDisabled();
    const down=row.getByRole("button",{name:"Move down",exact:true});await expect(down).toBeEnabled();await expect(down).not.toHaveAttribute("title",/./);
    await page.screenshot({path:join(shotsDir,"sidebar-codex-search-beyond-first-page-1600x980.png"),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
    // The first move in Pinned writes the order the sidebar shows (newest first) with the move made: only the moved thread goes to the end.
    await down.click();
    await expect.poll(moves).toEqual([{threadId:"codex-many-102",sectionId:"0198-pinned",beforeThreadId:null}]);
    expect(harness.order.get("0198-pinned")).toEqual(["codex-many-0","codex-many-1","codex-many-103","codex-many-102"]);
    await expect.poll(()=>sidebarGroups(page),{timeout:10_000}).toEqual([["Pinned",["Needle oldest thread","Needle second oldest"]]]);
    // From then on the search's threads hold Codex's order, and Move up is Codex's own move.
    await (await menu("Needle second oldest")).getByRole("button",{name:"Move up",exact:true}).click();
    await expect.poll(()=>moves().at(-1)).toEqual({threadId:"codex-many-102",sectionId:"0198-pinned",beforeThreadId:"codex-many-103"});
    await expect.poll(()=>sidebarGroups(page),{timeout:10_000}).toEqual([["Pinned",["Needle second oldest","Needle oldest thread"]]]);
    expect(harness.order.get("0198-pinned")).toEqual(["codex-many-0","codex-many-1","codex-many-102","codex-many-103"]);
  }finally{await harness.close()}
});

// A group is named after any section a thread is in, so its header gets whatever name a Codex client gave that section.
for(const [width,height] of [[1180,800],[1280,800],[1600,980]])test(`a group named after a long section stays inside the sidebar and keeps its count at ${width}x${height}`,async({page})=>{
  test.setTimeout(45_000);
  await page.setViewportSize({width,height});
  const sections=[
    {id:"0198-pinned",name:"Pinned",appearance:null},{id:"0198-snoozed",name:"Snoozed",appearance:null},{id:"0198-settled",name:"Settled",appearance:null},
    {id:"0199-spaced",name:"Customer escalations and follow-ups for the Q4 planning cycle",appearance:null},
    {id:"0199-unbroken",name:"customer_escalations_followups_2026_q4_planning_review",appearance:null},
    {id:"0198f3a2-5c1e-7b3d-9a4f-2c8e1d6b7a90",name:"0198f3a2-5c1e-7b3d-9a4f-2c8e1d6b7a90",appearance:null},
  ];
  const base={cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-900,turns:[]},section=id=>sections.find(item=>item.id===id);
  const threads=[
    {...base,id:"p1",name:"Pinned work",updatedAt:now()-30,section:section("0198-pinned")},
    {...base,id:"a1",name:"An active thread with a fairly long title that needs truncation in the sidebar",updatedAt:now()-10,section:null},
    {...base,id:"s1",name:"Escalation follow-up thread",updatedAt:now()-40,section:section("0199-spaced")},
    {...base,id:"u1",name:"Unbroken section thread",updatedAt:now()-50,section:section("0199-unbroken")},
    {...base,id:"u2",name:"Another unbroken section thread",updatedAt:now()-55,section:section("0199-unbroken")},
    {...base,id:"i1",name:"Id-named section thread",updatedAt:now()-60,section:section("0198f3a2-5c1e-7b3d-9a4f-2c8e1d6b7a90")},
  ];
  const meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}]));
  const harness=await startCodexHarness(threads,sections);
  try{
    await openApp(page,{harness,threads,meta});
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Pinned work"]],["Active",["An active thread with a fairly long title that needs truncation in the sidebar"]],...sections.slice(3).map(item=>[item.name,threads.filter(thread=>thread.section?.id===item.id).map(thread=>thread.name)])]);
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value;document.documentElement.style.colorScheme=value},mode);await settle(page);
      // Read as a person sees a header: its name (the first thing in it, whatever element holds it) and its count (the last).
      const metrics=await page.evaluate(()=>{
        const list=document.querySelector(".sidebar .thread-sections"),edge=document.querySelector(".sidebar").getBoundingClientRect().right;
        const box=node=>{if(node.nodeType===1)return node.getBoundingClientRect();const range=document.createRange();range.selectNodeContents(node);return range.getBoundingClientRect()};
        return {scroll:list.scrollWidth,client:list.clientWidth,edge,headers:[...list.querySelectorAll("section h4")].map(h4=>{const name=h4.firstChild,count=h4.lastElementChild,element=name.nodeType===1?name:null;return {name:name.textContent,title:element?.title??null,truncated:Boolean(element)&&element.scrollWidth>element.clientWidth,nameRight:box(name).right,countLeft:count.getBoundingClientRect().left,countRight:count.getBoundingClientRect().right,count:count.textContent,height:h4.getBoundingClientRect().height,weight:getComputedStyle(element||h4).fontWeight,headerWeight:getComputedStyle(h4).fontWeight}})};
      });
      // Nothing is wider than the list, so it cannot be scrolled sideways, and every header's count shows inside the sidebar, after its name.
      expect(metrics.scroll).toBeLessThanOrEqual(metrics.client);
      for(const header of metrics.headers){
        expect(header.countRight).toBeLessThanOrEqual(metrics.edge);expect(header.nameRight).toBeLessThanOrEqual(header.countLeft);
        expect(header.title).toBe(header.name);expect(header.weight).toBe(header.headerWeight);expect(header.height).toBeLessThan(30);
      }
      // A name too long for one line ends in an ellipsis; the short ones are whole.
      expect(metrics.headers.map(header=>[header.name,header.truncated,header.count])).toEqual([["Pinned",false,"1"],["Active",false,"1"],[sections[3].name,true,"1"],[sections[4].name,true,"2"],[sections[5].name,true,"1"]]);
      await page.screenshot({path:join(shotsDir,`sidebar-long-section-names-${mode}-${width}x${height}.png`),animations:"disabled",clip:{x:0,y:0,width:Math.min(width,520),height:Math.min(height,640)}});
      // Scrolled to its end and sideways, as a trackpad does: the threads stay in view.
      const scrolled=await page.evaluate(()=>{const list=document.querySelector(".sidebar .thread-sections");list.scrollTop=list.scrollHeight;list.scrollLeft=1000;return list.scrollLeft});
      expect(scrolled).toBe(0);await settle(page);
      await page.screenshot({path:join(shotsDir,`sidebar-long-section-names-scrolled-${mode}-${width}x${height}.png`),animations:"disabled",clip:{x:0,y:0,width:Math.min(width,520),height}});
      await page.evaluate(()=>{document.querySelector(".sidebar .thread-sections").scrollTop=0});
    }
  }finally{await harness.close()}
});

// Codex's built-in sections and one made in another Codex client, with three pinned threads (pinned alpha, beta, gamma: the order Codex
// keeps), two outside a section and two in Research.
const orderSections=[{id:"0198-pinned",name:"Pinned",appearance:null},{id:"0198-snoozed",name:"Snoozed",appearance:null},{id:"0198-settled",name:"Settled",appearance:null},{id:"0199-research",name:"Research",appearance:null}];
function orderThreads(){
  const base={cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-900,turns:[]},section=id=>orderSections.find(item=>item.id===id);
  return [
    {...base,id:"pinned-alpha",name:"Pinned alpha",updatedAt:now()-300,section:section("0198-pinned")},
    {...base,id:"pinned-beta",name:"Pinned beta",updatedAt:now()-200,section:section("0198-pinned")},
    {...base,id:"pinned-gamma",name:"Pinned gamma",updatedAt:now()-100,section:section("0198-pinned")},
    {...base,id:"active-one",name:"Codex active one",updatedAt:now()-10,section:null},
    {...base,id:"active-two",name:"Codex active two",updatedAt:now()-20,section:null},
    {...base,id:"research-one",name:"Research one",updatedAt:now()-60,section:section("0199-research")},
    {...base,id:"research-two",name:"Research two",updatedAt:now()-40,section:section("0199-research")},
  ];
}
const rowMenu=page=>async name=>{const row=threadRow(page,name);await row.hover();await row.locator(".thread-menu summary").click();await expect(row.locator(".thread-menu")).toHaveAttribute("open","");return row};
const sectionMoves=harness=>()=>harness.requests.filter(request=>request.method==="thread/section/move").map(request=>request.params);
// Bulk mode starts with the first thread selected; the rest are selected in the order given, and that first one is dropped.
async function selectInOrder(page,names){
  await page.locator(".sidebar-bulk-toggle").click();await expect(page.locator(".thread-select").first()).toBeVisible();
  const initially=await page.locator(".thread-row").evaluateAll(rows=>rows.filter(row=>row.querySelector(".thread-select")?.checked).map(row=>row.querySelector(".thread-main").title));
  for(const name of names)await threadRow(page,name).locator(".thread-select").check();
  for(const name of initially)if(!names.includes(name))await threadRow(page,name).locator(".thread-select").uncheck();
  await expect(page.locator(".bulk-bar span")).toHaveText(names.length+" selected");
}

// The row menu is drawn over whatever is around the list, so every item can be read and clicked on the last rows too: the list's edge
// fade and the destinations under it once hid most of it.
for(const [width,height] of [[1180,800],[1600,980]])test(`a thread's More actions menu lies whole over the sidebar footer on the list's last rows at ${width}x${height}, in dark and light`,async({page})=>{
  test.setTimeout(45_000);
  await page.setViewportSize({width,height});
  const threads=orderThreads(),meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}]));
  const harness=await startCodexHarness(threads,orderSections),menu=rowMenu(page),moves=sectionMoves(harness);
  harness.order.set("0199-research",["research-two","research-one"]);
  try{
    await openApp(page,{harness,threads,meta,settings:{orderedThreadSections:["0199-research"]}});
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Pinned gamma","Pinned beta","Pinned alpha"]],["Active",["Codex active one","Codex active two"]],["Research",["Research two","Research one"]]]);
    for(const mode of ["dark","light"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value;document.documentElement.style.colorScheme=value},mode);await settle(page);
      for(const name of ["Research two","Research one"]){
        // As the menu opens (read in the same task as the click), what a pointer meets at the middle of each item is that item, and the
        // whole menu is inside the window.
        const row=threadRow(page,name);await row.hover();
        const probe=await row.evaluate(node=>{document.activeElement?.blur?.();node.querySelector(".thread-menu summary").click();const pop=node.querySelector(".thread-menu-popover"),box=pop.getBoundingClientRect();return {
          inside:box.top>=0&&box.left>=0&&box.bottom<=innerHeight&&box.right<=innerWidth,
          items:[...pop.querySelectorAll("button")].map(button=>{const b=button.getBoundingClientRect(),hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return [button.textContent,Boolean(hit)&&(hit===button||button.contains(hit))]}),
        }});
        await expect(row.locator(".thread-menu")).toHaveAttribute("open","");await settle(page);
        expect(probe.inside).toBe(true);
        expect(probe.items.map(([label])=>label)).toEqual(expect.arrayContaining(["Pin","Settle","Move up","Move down","Archive","Delete"]));
        expect(probe.items.filter(([,hit])=>!hit)).toEqual([]);
        if(name==="Research one")await page.screenshot({path:join(shotsDir,`sidebar-row-menu-last-row-${mode}-${width}x${height}.png`),animations:"disabled",clip:{x:0,y:0,width:Math.min(width,520),height}});
        await page.keyboard.press("Escape");await expect(row.locator(".thread-menu")).not.toHaveAttribute("open","");
      }
    }
    // From the keyboard: Enter on the focused button opens the menu whole, Tab goes on to its first item, and Escape closes it and gives
    // the button its focus back.
    const last=threadRow(page,"Research one"),button=last.locator(".thread-menu summary");
    await last.hover();await button.focus();await page.keyboard.press("Enter");await expect(last.locator(".thread-menu")).toHaveAttribute("open","");
    expect(await last.locator(".thread-menu-popover").evaluate(pop=>[...pop.querySelectorAll("button")].every(item=>{const b=item.getBoundingClientRect(),hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return hit===item||item.contains(hit)}))).toBe(true);
    await page.keyboard.press("Tab");await expect(last.getByRole("button",{name:"Pin",exact:true})).toBeFocused();
    await page.keyboard.press("Escape");await expect(last.locator(".thread-menu")).not.toHaveAttribute("open","");await expect(button).toBeFocused();
    // A real click on the last row's Move up reaches it.
    await (await menu("Research one")).getByRole("button",{name:"Move up",exact:true}).click();
    await expect.poll(moves).toEqual([{threadId:"research-one",sectionId:"0199-research",beforeThreadId:"research-two"}]);
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Pinned gamma","Pinned beta","Pinned alpha"]],["Active",["Codex active one","Codex active two"]],["Research",["Research one","Research two"]]]);
  }finally{await harness.close()}
});

test("on a relay harness a bulk Pin un-done puts the threads a person placed back in their places, whatever order they were selected in",async({page})=>{
  test.setTimeout(60_000);
  const home=await mkdtemp(join(tmpdir(),"trebell-relay-bulk-undo-"));const relay=await startRelay(home);
  const base=Math.floor(Date.now()/1000)-3600,names=["Bulk R1","Bulk R2","Bulk R3","Bulk R4","Bulk R5"];
  const ids=names.map((name,index)=>relay.threadStore.importHistory({runtime:"native",cwd:process.cwd(),providerSessionId:"relay-bulk-undo-"+index,model:"fixture-model",name,preview:name,createdAt:base-600,updatedAt:base-index*60}).id);
  const meta=Object.fromEntries(ids.map(id=>[id,{projectless:false,environmentId:null,runtime:"native"}])),menu=rowMenu(page);
  const move=async(name,label)=>(await menu(name)).getByRole("button",{name:label,exact:true}).click();
  try{
    await openApp(page,{harness:relay,threads:[],meta,runtime:"native"});
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",names]]);
    // A person places R4 and R5, then pins both, selecting the lower one first, and undoes it.
    await move("Bulk R4","Move up");await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",["Bulk R1","Bulk R2","Bulk R4","Bulk R3","Bulk R5"]]]);
    await move("Bulk R5","Move up");
    const placed=[["Active",["Bulk R1","Bulk R2","Bulk R4","Bulk R5","Bulk R3"]]];
    await expect.poll(()=>sidebarGroups(page)).toEqual(placed);
    await selectInOrder(page,["Bulk R5","Bulk R4"]);
    await page.locator(".bulk-bar").getByRole("button",{name:"Pin",exact:true}).click();
    await expect.poll(()=>sidebarGroups(page).then(groups=>groups.find(group=>group[0]==="Pinned")?.[1].length)).toBe(2);
    await page.getByTestId("thread-undo-toast").getByRole("button",{name:"Undo",exact:true}).click();
    await expect.poll(()=>sidebarGroups(page)).toEqual(placed);
    await page.screenshot({path:join(shotsDir,"sidebar-relay-bulk-undo-1600x980.png"),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
    // The relay keeps that order.
    await page.reload();await expect.poll(()=>sidebarGroups(page)).toEqual(placed);
    await expect(page.getByText(/Could not put back/)).toHaveCount(0);
  }finally{await relay.close();await rm(home,{recursive:true,force:true}).catch(()=>{})}
});

test("on Codex a bulk Pin un-done puts the threads of a section a person ordered back in its order, whatever order they were selected in",async({page})=>{
  test.setTimeout(45_000);
  const base={cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-900,turns:[]},section=id=>orderSections.find(item=>item.id===id);
  const threads=[
    {...base,id:"pinned-gamma",name:"Pinned gamma",updatedAt:now()-100,section:section("0198-pinned")},
    {...base,id:"active-one",name:"Codex active one",updatedAt:now()-10,section:null},
    {...base,id:"research-a",name:"Research A",updatedAt:now()-60,section:section("0199-research")},
    {...base,id:"research-b",name:"Research B",updatedAt:now()-40,section:section("0199-research")},
    {...base,id:"research-c",name:"Research C",updatedAt:now()-50,section:section("0199-research")},
  ];
  const meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}]));
  const harness=await startCodexHarness(threads,orderSections);harness.order.set("0199-research",["research-a","research-b","research-c"]);
  try{
    await openApp(page,{harness,threads,meta,settings:{orderedThreadSections:["0198-pinned","0199-research"]}});
    const ordered=[["Pinned",["Pinned gamma"]],["Active",["Codex active one"]],["Research",["Research A","Research B","Research C"]]];
    await expect.poll(()=>sidebarGroups(page)).toEqual(ordered);
    await selectInOrder(page,["Research B","Research A"]);
    await page.locator(".bulk-bar").getByRole("button",{name:"Pin",exact:true}).click();
    await expect.poll(()=>sidebarGroups(page).then(groups=>groups.find(group=>group[0]==="Pinned")?.[1].length)).toBe(3);
    await page.getByTestId("thread-undo-toast").getByRole("button",{name:"Undo",exact:true}).click();
    await expect.poll(()=>harness.order.get("0199-research")).toEqual(["research-a","research-b","research-c"]);
    await expect.poll(()=>sidebarGroups(page)).toEqual(ordered);
    await expect(page.getByText(/Could not put back/)).toHaveCount(0);
  }finally{await harness.close()}
});

test("on a relay harness Archive and then Undo puts a thread nobody moved back in its place, with its age",async({page})=>{
  test.setTimeout(45_000);
  const home=await mkdtemp(join(tmpdir(),"trebell-relay-archive-undo-"));const relay=await startRelay(home);
  const base=Math.floor(Date.now()/1000)-3*3600,names=["Kept one","Kept two","Kept three","Kept four"];
  const ids=names.map((name,index)=>relay.threadStore.importHistory({runtime:"native",cwd:process.cwd(),providerSessionId:"relay-archive-undo-"+index,model:"fixture-model",name,preview:name,createdAt:base-600,updatedAt:base-index*3600}).id);
  const meta=Object.fromEntries(ids.map(id=>[id,{projectless:false,environmentId:null,runtime:"native"}])),menu=rowMenu(page);
  const ages=()=>page.locator(".thread-row").evaluateAll(rows=>rows.map(row=>[row.querySelector(".thread-main").title,row.querySelector(".thread-main > div > span")?.textContent]));
  try{
    await openApp(page,{harness:relay,threads:[],meta,runtime:"native"});
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",names]]);
    const before=await ages();
    await (await menu("Kept three")).getByRole("button",{name:"Archive",exact:true}).click();
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",["Kept one","Kept two","Kept four"]]]);
    // Archiving is not activity: the thread keeps its last-update time.
    expect(relay.threadStore.getMetadata(ids[2]).updatedAt).toBe(base-2*3600);
    await page.getByTestId("thread-undo-toast").getByRole("button",{name:"Undo",exact:true}).click();
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Active",names]]);
    await expect.poll(ages).toEqual(before);
    expect(relay.threadStore.getMetadata(ids[2]).updatedAt).toBe(base-2*3600);
    await page.screenshot({path:join(shotsDir,"sidebar-relay-archive-undo-1600x980.png"),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
  }finally{await relay.close();await rm(home,{recursive:true,force:true}).catch(()=>{})}
});

test("on Codex a move shows at once, and one made while an earlier move is still being written or read back starts from it",async({page})=>{
  test.setTimeout(60_000);
  const threads=orderThreads(),meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}]));
  let slow=false;
  const harness=await startCodexHarness(threads,orderSections,{listDelay:()=>slow?2500:0}),menu=rowMenu(page),moves=sectionMoves(harness);
  const pinned=async()=>(await sidebarGroups(page)).find(group=>group[0]==="Pinned")?.[1];
  const move=async(name,label)=>(await menu(name)).getByRole("button",{name:label,exact:true}).click();
  try{
    await openApp(page,{harness,threads,meta});
    await expect.poll(pinned).toEqual(["Pinned gamma","Pinned beta","Pinned alpha"]);
    // The list is slow to read back: each move shows before it is, and the next move starts from the order on screen.
    slow=true;
    await move("Pinned alpha","Move up");
    await expect.poll(pinned,{timeout:1500}).toEqual(["Pinned gamma","Pinned alpha","Pinned beta"]);
    await move("Pinned gamma","Move down");
    await expect.poll(pinned,{timeout:1500}).toEqual(["Pinned alpha","Pinned gamma","Pinned beta"]);
    await expect.poll(()=>harness.order.get("0198-pinned"),{timeout:10_000}).toEqual(["pinned-alpha","pinned-gamma","pinned-beta"]);
    expect(moves()).toEqual([{threadId:"pinned-alpha",sectionId:"0198-pinned",beforeThreadId:null},{threadId:"pinned-beta",sectionId:"0198-pinned",beforeThreadId:null},{threadId:"pinned-gamma",sectionId:"0198-pinned",beforeThreadId:"pinned-beta"}]);
    // Two Move up clicks on one thread take it up two places.
    await move("Pinned beta","Move up");
    await expect.poll(pinned,{timeout:1500}).toEqual(["Pinned alpha","Pinned beta","Pinned gamma"]);
    await move("Pinned beta","Move up");
    await expect.poll(pinned,{timeout:1500}).toEqual(["Pinned beta","Pinned alpha","Pinned gamma"]);
    await expect.poll(()=>harness.order.get("0198-pinned"),{timeout:10_000}).toEqual(["pinned-beta","pinned-alpha","pinned-gamma"]);
    expect(moves().slice(3)).toEqual([{threadId:"pinned-beta",sectionId:"0198-pinned",beforeThreadId:"pinned-gamma"},{threadId:"pinned-beta",sectionId:"0198-pinned",beforeThreadId:"pinned-alpha"}]);
    // Once every read is back, the sidebar shows what Codex keeps.
    slow=false;
    await page.waitForTimeout(3000);
    expect(await pinned()).toEqual(["Pinned beta","Pinned alpha","Pinned gamma"]);
    await page.screenshot({path:join(shotsDir,"sidebar-codex-moves-while-reading-1600x980.png"),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
    await page.reload();await expect.poll(pinned).toEqual(["Pinned beta","Pinned alpha","Pinned gamma"]);
  }finally{await harness.close()}
});

// The thread actions' code loads at idle after the first paint (thread-actions.js, B11). Moves made before it has come run once it is
// in, each as a click made then: from the order the move before gave the list. So two Move up clicks take a thread up two places, as
// they do once the code is in (the test above): the first writes Pinned in the order shown with the move, the second is Codex's own.
test("on Codex two Move up clicks made before the thread actions have loaded take the thread up two places once they come",async({page})=>{
  test.setTimeout(60_000);
  const threads=orderThreads(),meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}]));
  const held=[];
  await page.route(/\/assets\/thread-actions-[^/]*\.js$/,route=>{held.push(route)});
  const harness=await startCodexHarness(threads,orderSections),menu=rowMenu(page),moves=sectionMoves(harness);
  const pinned=async()=>(await sidebarGroups(page)).find(group=>group[0]==="Pinned")?.[1];
  const move=async(name,label)=>(await menu(name)).getByRole("button",{name:label,exact:true}).click();
  try{
    await openApp(page,{harness,threads,meta});
    await expect.poll(pinned).toEqual(["Pinned gamma","Pinned beta","Pinned alpha"]);
    await expect.poll(()=>held.length,{message:"the thread actions asked for at idle"}).toBe(1);
    await move("Pinned alpha","Move up");await move("Pinned alpha","Move up");
    // Nothing moves until the code comes.
    await page.waitForTimeout(500);expect(await pinned()).toEqual(["Pinned gamma","Pinned beta","Pinned alpha"]);expect(moves()).toEqual([]);
    for(const route of held.splice(0))await route.continue();
    await expect.poll(pinned,{timeout:5000}).toEqual(["Pinned alpha","Pinned gamma","Pinned beta"]);
    await expect.poll(()=>harness.order.get("0198-pinned"),{timeout:10_000}).toEqual(["pinned-alpha","pinned-gamma","pinned-beta"]);
    expect(moves()).toEqual([{threadId:"pinned-alpha",sectionId:"0198-pinned",beforeThreadId:null},{threadId:"pinned-beta",sectionId:"0198-pinned",beforeThreadId:null},{threadId:"pinned-alpha",sectionId:"0198-pinned",beforeThreadId:"pinned-gamma"}]);
    // Once the list is read back, it shows what Codex keeps.
    await page.waitForTimeout(1000);expect(await pinned()).toEqual(["Pinned alpha","Pinned gamma","Pinned beta"]);
    await page.screenshot({path:join(shotsDir,"sidebar-codex-moves-before-actions-load-1600x980.png"),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
  }finally{for(const route of held)await route.continue().catch(()=>{});await harness.close()}
});

test("on Codex a move made while a section's first ordering is still being written waits for it, and both hold",async({page})=>{
  test.setTimeout(60_000);
  const sections=orderSections.slice(0,3),base={cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-90000,turns:[]};
  // 40 pinned threads, newest first in the sidebar; Codex keeps them in the opposite order, so the first move writes 39 of them.
  const threads=Array.from({length:40},(_,index)=>({...base,id:"w-"+index,name:"W "+String(index).padStart(2,"0"),updatedAt:now()-600-index*60,section:sections[0]}));
  const meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}]));
  const harness=await startCodexHarness(threads,sections,{moveDelay:()=>40}),menu=rowMenu(page),moves=sectionMoves(harness);
  harness.order.set("0198-pinned",threads.map(thread=>thread.id).reverse());
  const head=async()=>(await sidebarGroups(page))[0]?.[1].slice(0,5);
  try{
    await openApp(page,{harness,threads,meta});
    await expect.poll(head).toEqual(["W 00","W 01","W 02","W 03","W 04"]);
    await (await menu("W 03")).getByRole("button",{name:"Move up",exact:true}).click();
    await expect.poll(head,{timeout:1500}).toEqual(["W 00","W 01","W 03","W 02","W 04"]);
    await expect.poll(()=>moves().length).toBeGreaterThan(5);
    expect(moves().length).toBeLessThan(39);
    await (await menu("W 00")).getByRole("button",{name:"Move down",exact:true}).click();
    await expect.poll(head,{timeout:1500}).toEqual(["W 01","W 00","W 03","W 02","W 04"]);
    await expect.poll(()=>moves().length,{timeout:20_000}).toBe(40);
    await expect.poll(()=>harness.order.get("0198-pinned").map(id=>id.slice(2)).join(",")).toBe(["1","0","3","2",...Array.from({length:36},(_,index)=>String(index+4))].join(","));
    expect(moves().at(-1)).toEqual({threadId:"w-0",sectionId:"0198-pinned",beforeThreadId:"w-3"});
    await page.waitForTimeout(500);expect(await head()).toEqual(["W 01","W 00","W 03","W 02","W 04"]);
    await page.screenshot({path:join(shotsDir,"sidebar-codex-move-during-first-ordering-1600x980.png"),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
  }finally{await harness.close()}
});

test("on Codex a first move that cannot read or save a section's order says which thread and which section it could not move",async({page})=>{
  test.setTimeout(45_000);
  const threads=orderThreads(),meta=Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}]));
  let failure="";
  const harness=await startCodexHarness(threads,orderSections,{failOrder:["0199-research"]}),menu=rowMenu(page),moves=sectionMoves(harness);
  const byActivity=[["Pinned",["Pinned gamma","Pinned beta","Pinned alpha"]],["Active",["Codex active one","Codex active two"]],["Research",["Research two","Research one"]]];
  const alert=page.locator(".sidebar-action-error");
  try{
    await openApp(page,{harness,threads,meta,settingsFailure:()=>failure});
    await expect.poll(()=>sidebarGroups(page)).toEqual(byActivity);
    // Research's order cannot be read: nothing moves, and the alert names the move and the section.
    await (await menu("Research two")).getByRole("button",{name:"Move down",exact:true}).click();
    await expect(alert).toHaveText("Could not move “Research two”: the order of Research could not be read (section order unavailable).");
    await page.screenshot({path:join(shotsDir,"sidebar-codex-first-move-unreadable-1600x980.png"),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
    expect(moves()).toEqual([]);await expect.poll(()=>sidebarGroups(page)).toEqual(byActivity);
    // Trebell cannot save that Pinned is ordered: the alert says so, and Pinned still shows by recent activity.
    failure="disk full";
    await (await menu("Pinned alpha")).getByRole("button",{name:"Move up",exact:true}).click();
    await expect(alert).toHaveText("Could not move “Pinned alpha”: the new order of Pinned could not be saved (disk full).");
    await expect.poll(()=>sidebarGroups(page)).toEqual(byActivity);
    for(const mode of ["light","dark"]){
      await page.evaluate(value=>{document.documentElement.dataset.mode=value;document.documentElement.style.colorScheme=value},mode);await settle(page);
      await page.screenshot({path:join(shotsDir,`sidebar-codex-first-move-unsaved-${mode}-1600x980.png`),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
    }
    // Tried again, it holds.
    failure="";
    await (await menu("Pinned alpha")).getByRole("button",{name:"Move up",exact:true}).click();
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Pinned gamma","Pinned alpha","Pinned beta"]],...byActivity.slice(1)]);
    await expect(alert).toHaveCount(0);
    expect(harness.order.get("0198-pinned")).toEqual(["pinned-gamma","pinned-alpha","pinned-beta"]);
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

// The page zoomed with the browser's keys (or laid out on a display Windows scales) is a fractional number of CSS pixels wide: at
// 110%, 125% and 150% the windows 991, 1126 and 1351px wide are 900.91, 900.8 and 900.67px. The shell docked the inspector at
// (min-width:901px) and made it the overlay drawer at (max-width:900px), so those widths matched neither: the 1120px rule's grid
// laid out a 460px column and a 360px inspector beside the 224px sidebar, 143px past the window's right edge, with the inspector's
// Close, Maximize, Commit and Sync out of view, and Tab to Sync slid the whole app sideways and left it there (UI lane D, round 8).
// App chose the drawer (its scrim and Escape) and the sidebar's width by window.innerWidth, which reads such a width as a whole
// number: at 175%, 200% and 250% the windows 1576, 1801 and 2251px wide are 900.57, 900.5 and 900.4px, which it read as 900. And a
// 1575px window at 175% is 900.00006px, which (max-width:900px) takes, within its 64th of a pixel of tolerance, and which
// (width > 900px) takes too. So the window is zoomed in a step at a time to 250%, through the zoom levels Chrome's Ctrl+= steps
// through, and at each step set to every width from the one at or under 900 CSS pixels to the one at or over 901 and back. A
// headless browser has no zoom keys or menu of its own: an extension of the test's own zooms the page with chrome.tabs.setZoom, as
// they do (the full Chromium's headless mode runs extensions). Its browser profile goes in the temp folder: under a test's output
// folder the profile's deepest files passed Windows' 260-character path limit, its service worker's script could not be kept, and
// the worker stopped.
const ZOOM_EXTENSION={
  "manifest.json":JSON.stringify({manifest_version:3,name:"Zoom",version:"1.0",background:{service_worker:"zoom.js"}}),
  "zoom.js":"self.zoomTo=async factor=>{const [tab]=await chrome.tabs.query({active:true});await chrome.tabs.setZoom(tab.id,factor)};",
};
for(const mode of ["dark","light"])test(`zoomed from 110% to 250%, the inspector docks inside the window or opens as the drawer with its scrim at every width around 900 CSS pixels, its Close, Maximize, Commit and Sync in view, Tab leaving the app in place and Escape closing only the drawer, in ${mode} mode`,async({playwright,baseURL,proxy,headless})=>{
  test.setTimeout(300_000);
  const project={id:"zoom-project",name:"Lane D Repository",path:process.cwd(),environmentId:null,branch:"main"};
  const threads=["Repo task one","Repo task two"].map((title,index)=>({id:"zoom-thread-"+(index+1),name:title,preview:"Repo",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60-index,updatedAt:now()-index,turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Look at "+title.toLowerCase()}]},{type:"agentMessage",id:"assistant-1",text:"Looked at "+title.toLowerCase()+"."}]}]}));
  const dir=await mkdtemp(join(tmpdir(),"trebell-zoom-")),extension=join(dir,"extension");mkdirSync(extension);
  for(const [name,text] of Object.entries(ZOOM_EXTENSION))writeFileSync(join(extension,name),text);
  const harness=await startHarness(threads);let context=null;
  try{
    context=await playwright.chromium.launchPersistentContext(join(dir,"profile"),{channel:"chromium",headless,baseURL,proxy,viewport:{width:1280,height:800},args:["--disable-extensions-except="+extension,"--load-extension="+extension]});
    const zoom=context.serviceWorkers()[0]||await context.waitForEvent("serviceworker");
    const page=context.pages()[0]||await context.newPage();
    await openApp(page,{harness,threads,meta:Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}])),project,settings:{appearanceMode:mode}});
    await openThread(page,threads[0].name);
    const right=page.getByTestId("right-panel"),toggle=page.getByTestId("right-panel-toggle");
    if(!(await right.isVisible())){await toggle.click();await expect(right).toBeVisible()}
    await right.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
    const message=right.getByPlaceholder("Commit message"),sync=right.getByRole("button",{name:"Sync",exact:true});
    const kept={Close:right.getByRole("button",{name:"Close right panel",exact:true}),Maximize:right.getByRole("button",{name:"Maximize right panel",exact:true}),Commit:right.getByRole("button",{name:"Commit",exact:true}),Sync:sync};
    await expect(message).toBeVisible();
    // The window's width in CSS pixels, the inspector, the conversation's column beside or under it and the sidebar, whether the
    // scrim shows (null: App drew none), and what scrolled sideways.
    const read=()=>page.evaluate(()=>{
      const box=node=>{const rect=node?.getBoundingClientRect();return rect?{left:+rect.left.toFixed(2),right:+rect.right.toFixed(2)}:null},scrim=document.querySelector("[data-testid=inspector-scrim]");
      return {width:document.documentElement.getBoundingClientRect().width,panel:box(document.querySelector("[data-testid=right-panel]")),column:box(document.querySelector(".chat-workspace")),sidebar:box(document.querySelector(".sidebar")),scrim:scrim?getComputedStyle(scrim).display!=="none":null,scrolled:[document.scrollingElement,document.querySelector(".app-shell"),document.querySelector(".workspace-shell")].filter(node=>node?.scrollLeft).map(node=>(node.className||node.tagName)+" "+node.scrollLeft)};
    });
    const seen=[];
    const at=async(level,width,shot)=>{
      await page.setViewportSize({width,height:Math.round(800*level)});
      // Settled: the same layout two frames running, at the window's width over the zoom.
      let state=null;
      await expect.poll(async()=>{await settle(page);const next=await read(),same=JSON.stringify(next)===JSON.stringify(state);state=next;return same&&Math.abs(next.width-width/level)<0.01},{message:`the layout settles at ${width}px zoomed to ${Math.round(level*100)}%`,intervals:[50]}).toBe(true);
      const where=`at ${width}px zoomed to ${Math.round(level*100)}% (${state.width.toFixed(3)} CSS pixels)`,edge=state.width+0.5,drawer=state.panel.left<state.column.right-0.5;
      seen.push(`${Math.round(level*100)}% ${width} ${state.width.toFixed(2)}px ${drawer?"drawer":"docked"} ${state.panel.left}-${state.panel.right}`);
      expect.soft(state.panel.right,`the inspector ends inside the window ${where}`).toBeLessThanOrEqual(edge);
      if(drawer){
        expect.soft(state.scrim,`the inspector over the conversation is the drawer, with its scrim, ${where}`).toBe(true);
        expect.soft(state.column.right,`the conversation under the drawer keeps the window's width ${where}`).toBeGreaterThanOrEqual(state.width-0.5);
      }else expect.soft(state.scrim,`the docked inspector has no scrim ${where}`).toBe(null);
      for(const [name,control] of Object.entries(kept)){const [left,end]=await control.evaluate(node=>{const rect=node.getBoundingClientRect();return [rect.left,rect.right]});expect.soft(left>=-0.5&&end<=edge,`${name} is wholly in the window ${where} (${left.toFixed(1)} to ${end.toFixed(1)})`).toBe(true)}
      // From the commit message Tab goes through the inspector to Sync, Commit on the way (a message typed in the inspector opened
      // again), and the app stays where it is.
      await message.click();
      if(!(await message.inputValue())){await page.keyboard.type("Fit the inspector",{delay:10});await expect(kept.Commit).toBeEnabled()}
      const passed=[];
      for(let presses=1;presses<=8&&!(await sync.evaluate(node=>node===document.activeElement));presses++){
        await page.keyboard.press("Tab");const now=await read();passed.push(await page.evaluate(()=>document.activeElement?.textContent?.trim()));
        expect.soft({sidebar:now.sidebar.left,scrolled:now.scrolled},`Tab ${presses} from the commit message leaves the app in place ${where}`).toEqual({sidebar:0,scrolled:[]});
      }
      expect.soft(passed,`Tab from the commit message passes Commit ${where}`).toContain("Commit");
      await expect.soft(sync,`Tab from the commit message reaches Sync ${where}`).toBeFocused();
      if(shot)await page.screenshot({path:join(shotsDir,`inspector-zoom-${Math.round(level*100)}-${mode}-${width}.png`),animations:"disabled"});
      // Escape closes the drawer, and only the drawer.
      await page.keyboard.press("Escape");await settle(page);
      if(drawer)await expect.soft(right,`Escape closes the drawer ${where}`).toBeHidden();
      else await expect.soft(right,`Escape leaves the docked inspector open ${where}`).toBeVisible();
      if(!(await right.isVisible())){await toggle.click();await expect(right).toBeVisible()}
      await expect(message).toBeVisible();
    };
    for(const level of [1.1,1.25,1.5,1.75,2,2.5]){
      // The window at the step's first width, then zoomed in a step, as Ctrl+= zooms it.
      const from=Math.floor(900*level),to=Math.ceil(901*level),widths=Array.from({length:to-from+1},(_,index)=>from+index);
      await page.setViewportSize({width:from,height:Math.round(800*level)});
      await zoom.evaluate(factor=>self.zoomTo(factor),level);
      await expect.poll(()=>page.evaluate(()=>devicePixelRatio),{message:`the window zooms to ${Math.round(level*100)}%`}).toBeCloseTo(level,3);
      for(const width of widths)await at(level,width,width/level>900.01&&width/level<900.99);
      for(const width of widths.slice(0,-1).reverse())await at(level,width,false);
    }
    console.log(`the inspector zoomed in ${mode} mode: ${seen.join(", ")}`);
  }finally{await context?.close();await harness.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
});

// The sidebar and the docked inspector each have a resize handle on their edge, which a pull or the arrow keys move. Where the shell
// fixes a width, the handles stood off any edge and moved nothing a person saw: the sidebar's stayed at the width the person had
// given the sidebar (258px) where the shell lays the sidebar out 224px wide (up to 1120px) or 196px (up to 900px), over the
// conversation or the drawer's dim, so a click on the dim there left the drawer open, and a pull or a key there moved only the handle,
// the sidebar then opening that wide in a wider window; and the inspector's stood the docked inspector's width (340px) in from the
// window's edge, 180px inside the 520px drawer, over its tabs, the branch select and the commit message, so a click on the select
// there did nothing, and Shift+Tab from the drawer's tabs reached it, whose keys set the inspector's width for wider windows (UI lane
// D, round 9). So at each width, zoomed to 100%, 110%, 125% and 150%, the mouse finds a handle only on an edge it moves and the keys
// reach only those; at 100% the handles shown take the pointer with their cursor and line and follow a pull and the arrow keys, and
// the places the others stood take the pointer and the clicks as what lies there does (the pull there last, so the dim is clicked
// where the handle stood); keys pressed on the sidebar's handle after the window narrows past 1120px change nothing; and each opens
// at its own width again at 1280px.
for(const mode of ["dark","light"])test(`a resize handle shows only on an edge it moves, the sidebar's where it takes its own width and the docked inspector's, and none where the shell narrows the sidebar or in the drawer, at 100% to 150% zoom, in ${mode} mode`,async({playwright,baseURL,proxy,headless})=>{
  test.setTimeout(300_000);
  const project={id:"handles-project",name:"Lane D Repository",path:process.cwd(),environmentId:null,branch:"main"};
  const threads=["Repo task one","Repo task two"].map((title,index)=>({id:"handles-thread-"+(index+1),name:title,preview:"Repo",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60-index,updatedAt:now()-index,turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Look at "+title.toLowerCase()}]},{type:"agentMessage",id:"assistant-1",text:"Looked at "+title.toLowerCase()+"."}]}]}));
  const dir=await mkdtemp(join(tmpdir(),"trebell-handles-")),extension=join(dir,"extension");mkdirSync(extension);
  for(const [name,text] of Object.entries(ZOOM_EXTENSION))writeFileSync(join(extension,name),text);
  const harness=await startHarness(threads);let context=null;
  try{
    context=await playwright.chromium.launchPersistentContext(join(dir,"profile"),{channel:"chromium",headless,baseURL,proxy,viewport:{width:1280,height:800},args:["--disable-extensions-except="+extension,"--load-extension="+extension]});
    const zoom=context.serviceWorkers()[0]||await context.waitForEvent("serviceworker");
    const page=context.pages()[0]||await context.newPage();
    await openApp(page,{harness,threads,meta:Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}])),project,settings:{appearanceMode:mode}});
    await openThread(page,threads[0].name);
    const right=page.getByTestId("right-panel"),toggle=page.getByTestId("right-panel-toggle"),branch=right.getByRole("combobox",{name:"Current branch"});
    const reopen=async()=>{if(!(await right.isVisible())){await toggle.click();await expect(right).toBeVisible()}await expect(branch).toBeVisible()};
    if(!(await right.isVisible())){await toggle.click();await expect(right).toBeVisible()}
    await right.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
    await expect(branch).toBeVisible();
    // Where the mouse finds each resize handle along three rows across the window (from and to, in CSS pixels), the sidebar (null:
    // collapsed), the inspector and the conversation's column.
    const read=()=>page.evaluate(()=>{
      const box=node=>{const rect=node?.getBoundingClientRect();return rect?.width?{left:+rect.left.toFixed(2),right:+rect.right.toFixed(2),width:+rect.width.toFixed(2)}:null},handles={};
      for(const y of [150,400,650])for(let x=0.5;x<innerWidth;x++){const id=document.elementFromPoint(x,y)?.closest(".layout-resizer")?.dataset.testid;if(id){const span=handles[id]||={from:x,to:x};span.from=Math.min(span.from,x);span.to=Math.max(span.to,x)}}
      return {width:document.documentElement.getBoundingClientRect().width,handles,sidebar:box(document.querySelector(".app-shell:not(.sidebar-collapsed)>.sidebar")),panel:box(document.querySelector("[data-testid=right-panel]")),column:box(document.querySelector(".chat-workspace"))};
    });
    const middle=span=>span?(span.from+span.to)/2:NaN;
    // What has the keyboard: a resize handle, by its name, or the part of the app it is in.
    const focused=()=>page.evaluate(()=>{const node=document.activeElement;return node?.getAttribute("role")==="separator"?node.getAttribute("aria-label"):node?.closest(".sidebar")?"the sidebar":node?.closest("[data-testid=right-panel]")?"the inspector":"the workspace"});
    const tabToSidebarHandle=async()=>{await page.locator(".sidebar-provider").focus();await page.keyboard.press("Tab")};
    const tabToPanelHandle=async()=>{await right.locator(".context-panel-tab").first().focus();await page.keyboard.press("Shift+Tab")};
    // What the pointer finds at a point once its hover has settled: the handle there (or the control, or the dim), the cursor it
    // shows and the handle's line.
    const pointer=async(x,y)=>{
      await page.mouse.move(x,y);let seen=null;
      await expect.poll(async()=>{const next=await page.evaluate(([x,y])=>{const node=document.elementFromPoint(x,y),handle=node.closest(".layout-resizer");return {under:handle?handle.getAttribute("aria-label"):node.getAttribute("aria-label")||node.dataset.testid||node.tagName.toLowerCase(),cursor:getComputedStyle(node).cursor,line:handle?getComputedStyle(handle,"::after").opacity:"none"}},[x,y]),same=JSON.stringify(next)===JSON.stringify(seen);seen=next;return same},{intervals:[60]}).toBe(true);
      return seen;
    };
    // The width of what a handle moves, and whether the handle is on its edge, once a pull or a key has moved it.
    const follows=(id,width,message)=>expect.poll(async()=>{const now=await read(),box=id==="sidebar-resizer"?now.sidebar:now.panel;return [Math.round(box.width),Math.abs(middle(now.handles[id])-(id==="sidebar-resizer"?box.right:box.left))<=1.5]},{message}).toEqual([width,true]);
    // The window set to css CSS pixels at the zoom, and the layout once it is the same two frames running.
    const settled=async(level,css)=>{
      await page.setViewportSize({width:Math.round(css*level),height:Math.round(800*level)});
      let state=null;
      await expect.poll(async()=>{await settle(page);const next=await read(),same=JSON.stringify(next)===JSON.stringify(state);state=next;return same&&Math.abs(next.width-css)<0.05},{message:`the layout settles at ${css} CSS pixels zoomed to ${Math.round(level*100)}%`,intervals:[50]}).toBe(true);
      return state;
    };
    const at=async(level,css)=>{
      const state=await settled(level,css);
      const where=`at ${css} CSS pixels zoomed to ${Math.round(level*100)}% (a ${Math.round(css*level)}px window)`,drawer=state.panel.left<state.column.right-0.5,own=css>1120;
      // The edges a pull or the keys move: the sidebar's where it takes its own width (the shell lays it out 224px wide up to 1120px
      // and 196px up to 900px, and collapses it under 820px), and the docked inspector's. Each opens at its own width at 1280px.
      if(state.sidebar)expect.soft(Math.round(state.sidebar.width),`the sidebar's width ${where}`).toBe(own?258:css>900?224:196);
      if(own)expect.soft(Math.round(state.panel.width),`the inspector's width ${where}`).toBe(460);
      const edges={...(own&&state.sidebar?{"sidebar-resizer":state.sidebar.right}:{}),...(drawer?{}:{"right-panel-resizer":state.panel.left})};
      const off=Object.entries(state.handles).filter(([id,span])=>!(id in edges)||Math.abs(middle(span)-edges[id])>1.5).map(([id,span])=>`${id} at ${span.from}-${span.to}`);
      expect.soft(off,`the mouse finds no resize handle off an edge it moves ${where} (the sidebar ends at ${state.sidebar?.right??"0, collapsed"}, the inspector is ${state.panel.left}-${state.panel.right}${drawer?", the drawer":""})`).toEqual([]);
      expect.soft(Object.keys(edges).filter(id=>!state.handles[id]),`each edge a person can move has its handle ${where}`).toEqual([]);
      await expect.soft(page.getByRole("separator",{name:"Resize sidebar"}),`the sidebar offers its resize handle ${where} only where it takes its own width`).toHaveCount(own&&state.sidebar?1:0,{timeout:1000});
      await expect.soft(page.getByRole("separator",{name:"Resize workspace panel"}),`the inspector offers its resize handle ${where} only where it is docked`).toHaveCount(drawer?0:1,{timeout:1000});
      // The handles shown take the pointer with their cursor and line, zoomed or not.
      for(const id of Object.keys(edges)){
        const handle=page.getByTestId(id);await handle.hover();
        await expect.poll(()=>handle.evaluate(node=>[node.matches(":hover"),getComputedStyle(node).cursor,getComputedStyle(node,"::after").opacity]),{message:`the handle ${id} under the pointer shows its cursor and line ${where}`}).toEqual([true,"col-resize","0.8"]);
      }
      // Tab from the sidebar's last control reaches its handle only where the sidebar takes its own width, and Shift+Tab from the
      // inspector's first tab reaches the inspector's only where it is docked.
      if(state.sidebar){await tabToSidebarHandle();expect.soft(await focused(),`Tab from the sidebar's last control ${where}`).toBe(own?"Resize sidebar":"the workspace")}
      await tabToPanelHandle();
      expect.soft(await focused(),`Shift+Tab from the inspector's first tab ${where}`).toBe(drawer?"the workspace":"Resize workspace panel");
      if(level!==1)return;
      // The key a person presses on the handle Shift+Tab reached in the drawer.
      if(drawer&&/^Resize/.test(await focused()))await page.keyboard.press("Shift+ArrowLeft");
      if(own){
        // The handles on the inspector's and the sidebar's edges take the pointer with their cursor and line, and a pull 40px and back
        // and the arrow keys move the edge with the handle on it.
        for(const [id,name,grow,width] of [["right-panel-resizer","Resize workspace panel",-1,460],["sidebar-resizer","Resize sidebar",1,258]]){
          expect.soft(await pointer(middle(state.handles[id]),400),`the pointer on the handle ${name} ${where}`).toEqual({under:name,cursor:"col-resize",line:"0.8"});
          if(id==="sidebar-resizer")await page.screenshot({path:join(shotsDir,`resize-handle-sidebar-hover-${mode}-${css}.png`),animations:"disabled"});
          for(const [dx,to] of [[40*grow,width+40],[-40*grow,width]]){
            const from=middle((await read()).handles[id]);
            await page.mouse.move(from,400);await page.mouse.down();await page.mouse.move(from+dx,400,{steps:6});await page.mouse.up();
            await follows(id,to,`a pull of ${dx}px on the handle ${name} ${where}`);
          }
          if(id==="sidebar-resizer")await tabToSidebarHandle();else await tabToPanelHandle();
          for(const [key,to] of [[grow>0?"ArrowRight":"ArrowLeft",width+16],[grow>0?"ArrowLeft":"ArrowRight",width]]){await page.keyboard.press(key);await follows(id,to,`${key} on the handle ${name} ${where}`)}
        }
        return;
      }
      if(state.sidebar&&!drawer){
        // Where the sidebar's handle stood, at the width the person gave the sidebar, the pointer finds the conversation, and a pull
        // there leaves the sidebar as the shell lays it out.
        const seen=await pointer(258.5,400);
        expect.soft([seen.under,seen.cursor,seen.line],`the pointer at x 258.5, where the sidebar's handle stood, ${where}`).toEqual([expect.not.stringMatching(/^Resize/),expect.not.stringMatching(/^col-resize$/),"none"]);
        if(css===1100){
          await page.screenshot({path:join(shotsDir,`resize-handle-none-sidebar-${mode}-${css}.png`),animations:"disabled"});
          await page.mouse.down();await page.mouse.move(298.5,400,{steps:6});await page.mouse.up();await settle(page);
          expect.soft(Math.round((await read()).sidebar.width),`the sidebar's width after a pull from x 258.5 ${where}`).toBe(224);
        }
      }
      if(drawer){
        // Where the inspector's handle stood in the drawer, 180px in from its left edge, the pointer finds the branch select, and a
        // click there gives the select the keyboard.
        const select=await branch.boundingBox(),x=state.panel.left+179.5,y=select.y+select.height/2;
        expect.soft(x>select.x&&x<select.x+select.width,`the branch select lies under x ${x}, 180px into the drawer, ${where}`).toBe(true);
        const seen=await pointer(x,y);
        expect.soft([seen.under,seen.cursor,seen.line],`the pointer on the branch select 180px into the drawer ${where}`).toEqual(["Current branch",expect.not.stringMatching(/^col-resize$/),"none"]);
        if(css===900)await page.screenshot({path:join(shotsDir,`resize-handle-none-drawer-${mode}-${css}.png`),animations:"disabled"});
        await page.mouse.click(x,y);
        await expect.soft(branch,`a click on the branch select 180px into the drawer ${where}`).toBeFocused();
        // Escape closes the list the click opened.
        await page.keyboard.press("Escape");await reopen();
        await expect.poll(()=>branch.evaluate(node=>{try{return node.matches(":open")}catch{return false}}),{message:`Escape closes the branch list ${where}`}).toBe(false);
        if(state.sidebar){
          // The dim where the sidebar's handle stood closes the drawer at a click.
          const dim=await pointer(256,400);
          expect.soft([dim.under,dim.line],`the pointer on the dim at x 256 ${where}`).toEqual(["inspector-scrim","none"]);
          await page.mouse.click(256,400);
          await expect.soft(right,`a click on the dim at x 256 closes the drawer ${where}`).toBeHidden();
          await reopen();
        }
      }
    };
    for(const level of [1,1.1,1.25,1.5]){
      if(level!==1){
        // The window at the step's first width, then zoomed in a step, as Ctrl+= zooms it.
        await page.setViewportSize({width:Math.round(1280*level),height:Math.round(800*level)});
        await zoom.evaluate(factor=>self.zoomTo(factor),level);
        await expect.poll(()=>page.evaluate(()=>devicePixelRatio),{message:`the window zooms to ${Math.round(level*100)}%`}).toBeCloseTo(level,3);
      }
      for(const css of level===1?[1280,1120,900,700,1100]:[1280,1120,1100,900,700])await at(level,css);
      if(level!==1)continue;
      // The sidebar's handle given the keyboard at 1280px, and the window narrowed to 1120px: the arrow keys pressed on change
      // nothing, and back at 1280px the sidebar and the inspector open at their own widths.
      await settled(1,1280);await tabToSidebarHandle();
      expect.soft(await focused(),"Tab from the sidebar's last control at 1280px").toBe("Resize sidebar");
      await settled(1,1120);
      for(let press=0;press<2;press++)await page.keyboard.press("ArrowRight");
      const back=await settled(1,1280);
      expect.soft([Math.round(back.sidebar.width),Math.round(back.panel.width)],"the sidebar's and the inspector's widths at 1280px after ArrowRight twice at 1120px").toEqual([258,460]);
    }
  }finally{await context?.close();await harness.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
});

// The overlay drawer gives the keyboard to the tab it shows when it opens, so Enter there keeps that tab. App took the first match of
// ".context-panel-tab.active,.context-panel-tab", and a selector list matches in the page's order, not in its own, so that was the
// strip's first tab: with the Git tab shown, the drawer opened as the window narrowed with the keyboard in the composer, by Enter or a
// click on its toggle or by Ctrl+Alt+B put the focus on Files, and Enter then switched the drawer to Files (UI lane D, round 9).
for(const mode of ["dark","light"])test(`the overlay drawer opened as the window narrows, by its toggle or by Ctrl+Alt+B gives the keyboard to the tab it shows, and Enter there keeps that tab, in ${mode} mode`,async({page})=>{
  test.setTimeout(60_000);
  const project={id:"drawer-focus-project",name:"Lane D Repository",path:process.cwd(),environmentId:null,branch:"main"};
  const threads=["Repo task one","Repo task two"].map((title,index)=>({id:"drawer-focus-thread-"+(index+1),name:title,preview:"Repo",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60-index,updatedAt:now()-index,turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Look at "+title.toLowerCase()}]},{type:"agentMessage",id:"assistant-1",text:"Looked at "+title.toLowerCase()+"."}]}]}));
  const harness=await startHarness(threads);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads,meta:Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}])),project,settings:{appearanceMode:mode}});
    await openThread(page,threads[0].name);
    const right=page.getByTestId("right-panel"),toggle=page.getByTestId("right-panel-toggle"),git=right.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}),message=right.getByPlaceholder("Commit message");
    // What has the keyboard: a tab of the drawer, by its name, or what else.
    const focused=()=>page.evaluate(()=>{const node=document.activeElement;return node?.classList.contains("context-panel-tab")?"the "+node.getAttribute("aria-label")+" tab":node?.getAttribute("aria-label")||node?.dataset?.testid||node?.tagName.toLowerCase()||"nothing"});
    const showGit=async()=>{if(!(await git.evaluate(node=>node.classList.contains("active"))))await git.click();await expect(git).toHaveClass(/active/);await expect(message).toBeVisible()};
    if(!(await right.isVisible())){await toggle.click();await expect(right).toBeVisible()}
    await showGit();
    // The drawer opened one way with the Git tab shown: the keyboard goes to Git, Enter there leaves Git and its commit message shown,
    // and Escape closes the drawer.
    const opened=async(how,shot)=>{
      await expect(right).toBeVisible();
      await expect.soft(git,`the drawer opened ${how} gives the keyboard to the Git tab it shows`).toBeFocused({timeout:3000});
      expect.soft(await focused(),`what has the keyboard once the drawer opened ${how}`).toBe("the Git tab");
      if(shot)await page.screenshot({path:join(shotsDir,`drawer-focus-shown-tab-${mode}-900.png`),animations:"disabled"});
      await page.keyboard.press("Enter");await settle(page);
      await expect.soft(git,`Enter right after the drawer opened ${how} keeps the Git tab`).toHaveClass(/active/);
      await expect.soft(message,`Enter right after the drawer opened ${how} keeps the Git tab's commit message`).toBeVisible();
      await showGit();
      await page.keyboard.press("Escape");await expect(right).toBeHidden();
    };
    await page.getByTestId("composer").click();
    await page.setViewportSize({width:900,height:800});await expect(page.getByTestId("inspector-scrim")).toBeVisible();
    await opened("as the window narrows with the keyboard in the composer");
    await toggle.focus();await page.keyboard.press("Enter");await opened("by Enter on its toggle",true);
    await toggle.click();await opened("by a click on its toggle");
    await page.keyboard.press(process.platform==="darwin"?"Meta+Alt+B":"Control+Alt+B");await opened("by Ctrl+Alt+B");
  }finally{await harness.close()}
});

// The docked inspector's resize handle takes the inspector as wide as the window lets it show, and its grow key and a pull to widen
// never narrow it. App laid the inspector out up to the window less the sidebar's column as the shell lays it out (224px up to 1120px
// wide) and 400px for the conversation, but stopped its keys and a pull at the window less the width the person gave the sidebar
// (258px) and 480px: in a 1100px window an inspector set to 404px showed 404px beside a handle whose maximum was 362px, so ArrowLeft,
// the grow key, and a 5px pull to the left narrowed it to 362px and widened the conversation, and one widened in a wider window showed
// 476px at 1100px and 622px at 1280px and went to 362px and 542px (UI lane D, round 9). So in 1100, 1280 and 1600px windows, with the
// inspector set wider than the window lets it show (in a wider window, or before the sidebar is collapsed or widened) and as wide as
// it shows, the handle on its edge says its width and a maximum no narrower, the inspector set wider shows at that maximum, ArrowLeft
// and pulls to the left widen it up to there and never narrow it, ArrowRight, Home and End take it where they say, End and a long pull
// reach the maximum, and the conversation beside it at its widest keeps 400px.
for(const mode of ["dark","light"])test(`the docked inspector's resize handle reaches as wide as the inspector shows, and its grow key and a pull to widen never narrow it, at 1100, 1280 and 1600px, in ${mode} mode`,async({page})=>{
  test.setTimeout(150_000);
  const project={id:"inspector-width-project",name:"Lane D Repository",path:process.cwd(),environmentId:null,branch:"main"};
  const threads=["Repo task one","Repo task two"].map((title,index)=>({id:"inspector-width-thread-"+(index+1),name:title,preview:"Repo",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60-index,updatedAt:now()-index,turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Look at "+title.toLowerCase()}]},{type:"agentMessage",id:"assistant-1",text:"Looked at "+title.toLowerCase()+"."}]}]}));
  const harness=await startHarness(threads);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads,meta:Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}])),project,settings:{appearanceMode:mode}});
    await openThread(page,threads[0].name);
    const right=page.getByTestId("right-panel"),toggle=page.getByTestId("right-panel-toggle"),handle=page.getByTestId("right-panel-resizer");
    if(!(await right.isVisible())){await toggle.click();await expect(right).toBeVisible()}
    // The inspector's width, the handle's value and maximum, the sidebar's and the conversation's widths, and whether the handle is on
    // the inspector's edge and the inspector inside the window.
    const read=()=>page.evaluate(()=>{
      const box=node=>node?.getBoundingClientRect(),panel=box(document.querySelector("[data-testid=right-panel]")),node=document.querySelector("[data-testid=right-panel-resizer]"),grip=box(node),sidebar=box(document.querySelector(".app-shell:not(.sidebar-collapsed)>.sidebar"));
      return {width:Math.round(panel.width),now:Number(node.getAttribute("aria-valuenow")),max:Number(node.getAttribute("aria-valuemax")),sidebar:Math.round(sidebar?.width||0),column:Math.round(box(document.querySelector(".chat-workspace")).width),onEdge:Math.abs(grip.left+grip.width/2-panel.left)<=1.5,inside:panel.right<=innerWidth+0.5};
    });
    // The window set to width, once its layout is the same two frames running.
    const settled=async width=>{
      await page.setViewportSize({width,height:800});let state=null;
      await expect.poll(async()=>{await settle(page);const next=await read(),same=JSON.stringify(next)===JSON.stringify(state);state=next;return same},{message:`the layout settles at ${width}px`,intervals:[50]}).toBe(true);
      return state;
    };
    // The keyboard on the handle, as Shift+Tab from the inspector's first tab brings it there, and a pull of dx px on the handle.
    const toHandle=async()=>{if(!(await handle.evaluate(node=>node===document.activeElement))){await right.locator(".context-panel-tab").first().focus();await page.keyboard.press("Shift+Tab")}await expect(handle).toBeFocused()};
    const pull=async dx=>{const grip=await handle.boundingBox(),x=grip.x+grip.width/2,y=grip.y+300;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(Math.max(2,x+dx),y,{steps:6});await page.mouse.up()};
    // The width a key or a pull leaves, from the inspector as it was: wider by n up to the handle's maximum and never narrower, or
    // narrower by n down to 340px.
    const wider=n=>was=>Math.max(was.width,Math.min(was.width+n,was.max)),narrower=n=>was=>Math.max(340,was.width-n);
    // A key or a pull on the handle: the width it leaves the inspector, the handle on its edge saying it, and the conversation giving
    // or taking what the inspector takes or gives.
    const moves=async(where,how,act,to)=>{
      const was=await read(),want=to(was);await act();
      await expect.soft.poll(async()=>{const now=await read();return [now.width,now.now,now.onEdge]},{message:`${how} ${where}, from ${was.width}px with the handle's maximum at ${was.max}px`,timeout:2000}).toEqual([want,want,true]);
      const now=await read();
      expect.soft(Math.abs(now.column+now.width-was.column-was.width),`the conversation gives or takes what the inspector takes or gives at ${how} ${where}`).toBeLessThanOrEqual(1);
      return now;
    };
    // The inspector as the window shows it: the handle on its edge saying its width, with a maximum no narrower, and, set wider than
    // the window lets it show, at that maximum.
    const shows=(where,state,setWider)=>{
      expect.soft([state.now,state.onEdge,state.inside],`the handle on the inspector's edge says its width ${where}, the inspector inside the window`).toEqual([state.width,true,true]);
      expect.soft(state.max,`the handle's maximum ${where} is no narrower than the ${state.width}px inspector`).toBeGreaterThanOrEqual(state.width);
      if(setWider)expect.soft(state.width,`the inspector set wider than the window lets it show ${where} shows at the handle's maximum`).toBe(state.max);
    };
    // The keys and pulls a person widens and narrows the inspector with, the grow key or a pull first, and the conversation's width
    // beside it at its widest.
    const exercise=async(where,shot,pullFirst)=>{
      await toHandle();
      const key=()=>moves(where,"ArrowLeft, the grow key,",()=>page.keyboard.press("ArrowLeft"),wider(16)),small=()=>moves(where,"a 5px pull to the left",()=>pull(-5),wider(5));
      if(pullFirst){await small();await key()}else{await key();await small()}
      await moves(where,"a 40px pull to the left",()=>pull(-40),wider(40));
      await toHandle();
      const widest=await moves(where,"End",()=>page.keyboard.press("End"),was=>was.max);
      if(widest.max<820)expect.soft(widest.column,`the conversation beside the inspector at its widest ${where}`).toBe(400);
      else expect.soft(widest.column,`the conversation beside the inspector at its widest, 820px, ${where}`).toBeGreaterThanOrEqual(400);
      await moves(where,"ArrowLeft at the inspector's widest",()=>page.keyboard.press("ArrowLeft"),wider(16));
      await moves(where,"Shift+ArrowLeft at the inspector's widest",()=>page.keyboard.press("Shift+ArrowLeft"),wider(64));
      await moves(where,"a 40px pull to the left at the inspector's widest",()=>pull(-40),wider(40));
      if(shot)await page.screenshot({path:join(shotsDir,`inspector-handle-widest-${mode}-${shot}.png`),animations:"disabled"});
      await toHandle();
      await moves(where,"ArrowRight",()=>page.keyboard.press("ArrowRight"),narrower(16));
      await moves(where,"Shift+ArrowRight",()=>page.keyboard.press("Shift+ArrowRight"),narrower(64));
      await moves(where,"Home",()=>page.keyboard.press("Home"),()=>340);
      await moves(where,"Shift+ArrowLeft from the inspector's narrowest",()=>page.keyboard.press("Shift+ArrowLeft"),wider(64));
      await moves(where,"a pull to the window's left edge",()=>pull(-2000),was=>was.max);
      await moves(where,"a 40px pull to the right",()=>pull(40),narrower(40));
    };
    // The inspector at its widest in a 1600px window (End), wider than a narrower window lets it show.
    const widestAt1600=async()=>{await settled(1600);await toHandle();await page.keyboard.press("End");await expect.poll(async()=>(await read()).width).toBe(820)};
    // At 1100px, set to 404px at 1280px with the keys (Home, ArrowLeft, Shift+ArrowLeft, ArrowRight), the grow key first and then,
    // set so again, a pull.
    const at404=async()=>{await settled(1280);await toHandle();for(const key of ["Home","ArrowLeft","Shift+ArrowLeft","ArrowRight"])await page.keyboard.press(key);await expect.poll(async()=>(await read()).width).toBe(404);return settled(1100)};
    let where="at 1100px with the inspector set to 404px at 1280px";
    shows(where,await at404(),false);await exercise(where,"1100-404",false);
    where="at 1100px with the inspector set to 404px at 1280px again";
    shows(where,await at404(),false);await exercise(where,null,true);
    // At 1100px, set to its widest at 1600px, with the sidebar open and then collapsed.
    await widestAt1600();where="at 1100px with the inspector set to its widest at 1600px";
    shows(where,await settled(1100),true);await exercise(where,"1100",true);
    await widestAt1600();await settled(1100);
    await page.getByRole("button",{name:"Collapse sidebar"}).click();await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
    where="at 1100px with the sidebar collapsed and the inspector set to its widest at 1600px";
    shows(where,await settled(1100),true);await exercise(where,"1100-sidebar-collapsed",false);
    await page.getByRole("button",{name:"Open sidebar"}).first().click();await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-collapsed/);
    // At 1280px, set to its widest at 1600px.
    await widestAt1600();where="at 1280px with the inspector set to its widest at 1600px";
    shows(where,await settled(1280),true);await exercise(where,"1280",true);
    // At 1600px at its widest, and then with the sidebar widened to its widest (End on its handle, Tab from its last control).
    await widestAt1600();where="at 1600px with the inspector at its widest";
    shows(where,await settled(1600),false);await exercise(where,"1600",false);
    await widestAt1600();await page.locator(".sidebar-provider").focus();await page.keyboard.press("Tab");
    await expect(page.getByTestId("sidebar-resizer")).toBeFocused();await page.keyboard.press("End");
    await expect.poll(async()=>(await read()).sidebar).toBe(420);
    where="at 1600px with the inspector at its widest and then the sidebar widened to its widest";
    shows(where,await settled(1600),true);await exercise(where,"1600-sidebar-widest",true);
  }finally{await harness.close()}
});

// A key or a pull on the docked inspector's resize handle that leaves the inspector as wide as it shows keeps the width it was set
// to, which a wider window shows again. The keys and a pull start from the width shown, which the window caps (its width less the
// sidebar's column and 400px for the conversation), and stored what they left, so where an inspector set wider showed at its widest,
// the grow key, End or a pull to the left moved nothing and yet stored that narrower width over the one set: set to 622px at 1280px,
// it came back 476px after ArrowLeft at 1100px; set to 670px with the sidebar at its narrowest, 460px after ArrowLeft with the sidebar
// widened; and set to 820px at 1600px, 622px after ArrowLeft at 1280px (UI lane D, round 10). So there and at 1120px, the grow keys,
// End and pulls to the left that leave the inspector at its widest, and a pull there and back, keep the width set for the wider
// window, the window's trips to 900 and 700px (the overlay drawer) keep it too, and ArrowRight, Shift+ArrowRight, Home and a pull to
// the right, which narrow it, store the width they leave, which the wider window then shows, as ArrowLeft after them does.
for(const mode of ["dark","light"])test(`a key or a pull that leaves the docked inspector as wide as it shows keeps the width set for a wider window, at 1100, 1120 and 1280px and with the sidebar widened, in ${mode} mode`,async({page})=>{
  test.setTimeout(150_000);
  const project={id:"inspector-kept-project",name:"Lane D Repository",path:process.cwd(),environmentId:null,branch:"main"};
  const threads=["Repo task one","Repo task two"].map((title,index)=>({id:"inspector-kept-thread-"+(index+1),name:title,preview:"Repo",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60-index,updatedAt:now()-index,turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Look at "+title.toLowerCase()}]},{type:"agentMessage",id:"assistant-1",text:"Looked at "+title.toLowerCase()+"."}]}]}));
  const harness=await startHarness(threads);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads,meta:Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}])),project,settings:{appearanceMode:mode}});
    await openThread(page,threads[0].name);
    const right=page.getByTestId("right-panel"),toggle=page.getByTestId("right-panel-toggle"),handle=page.getByTestId("right-panel-resizer"),sidebarHandle=page.getByTestId("sidebar-resizer");
    if(!(await right.isVisible())){await toggle.click();await expect(right).toBeVisible()}
    // The inspector's width, its handle's value and maximum (null where the inspector is the overlay drawer, which has none) and the
    // sidebar's width.
    const read=()=>page.evaluate(()=>{
      const panel=document.querySelector("[data-testid=right-panel]")?.getBoundingClientRect(),node=document.querySelector("[data-testid=right-panel-resizer]"),docked=Boolean(node?.getClientRects().length),sidebar=document.querySelector(".app-shell:not(.sidebar-collapsed)>.sidebar")?.getBoundingClientRect();
      return {width:panel?Math.round(panel.width):null,now:docked?Number(node.getAttribute("aria-valuenow")):null,max:docked?Number(node.getAttribute("aria-valuemax")):null,sidebar:Math.round(sidebar?.width||0)};
    });
    // The window set to width, once its layout is the same two frames running.
    const settled=async width=>{
      await page.setViewportSize({width,height:800});let state=null;
      await expect.poll(async()=>{await settle(page);const next=await read(),same=JSON.stringify(next)===JSON.stringify(state);state=next;return same},{message:`the layout settles at ${width}px`,intervals:[50]}).toBe(true);
      return state;
    };
    // The keyboard on the inspector's handle, as Shift+Tab from its first tab brings it there, or a key on the sidebar's, as Tab from
    // the sidebar's last control brings it there; and a pull on the inspector's handle, which takes it, of each dx px in turn.
    const toHandle=async()=>{if(!(await handle.evaluate(node=>node===document.activeElement))){await right.locator(".context-panel-tab").first().focus();await page.keyboard.press("Shift+Tab")}await expect(handle).toBeFocused()};
    const sidebarKey=async key=>{await page.locator(".sidebar-provider").focus();await page.keyboard.press("Tab");await expect(sidebarHandle).toBeFocused();await page.keyboard.press(key)};
    const pull=async(...moves)=>{
      const grip=await handle.boundingBox(),y=grip.y+300;let x=grip.x+grip.width/2;
      await page.mouse.move(x,y);await page.mouse.down();await expect(page.locator("html"),"the pull takes the handle").toHaveClass(/layout-resizing/);
      for(const dx of moves){x+=dx;await page.mouse.move(x,y,{steps:6})}
      await page.mouse.up();
    };
    const keys=(...names)=>async()=>{for(const name of names)await page.keyboard.press(name)};
    // The inspector set as wide as it goes (End) in a window width px wide: want px.
    const widest=async(width,want)=>{await settled(width);await toHandle();await page.keyboard.press("End");await expect.poll(async()=>(await read()).width,{message:`End at ${width}px`}).toBe(want)};
    // A press or a pull in the narrower window at, where the inspector set as wide as it goes at from (set px) shows at its handle's
    // maximum (shows px): it leaves the inspector as wide as it shows, and the wider window shows the width set again.
    const kept=async(how,act,{from=1280,set=622,at,shows,shot})=>{
      await widest(from,set);
      const where=`at ${at}px with the inspector set to ${set}px at ${from}px`,was=await settled(at);
      expect.soft([was.width,was.now,was.max],`the inspector and its handle's value and maximum ${where}`).toEqual([shows,shows,shows]);
      await toHandle();await act();
      await expect.soft.poll(async()=>{const now=await read();return [now.width,now.now]},{message:`${how} ${where} leaves the inspector as wide as it shows`,timeout:2000}).toEqual([shows,shows]);
      expect.soft((await settled(from)).width,`back at ${from}px after ${how} ${where}, the inspector is the ${set}px it was set to`).toBe(set);
      if(shot)await page.screenshot({path:join(shotsDir,`inspector-kept-width-${mode}-${shot}.png`),animations:"disabled"});
    };
    for(const [how,act,shot] of [["ArrowLeft, the grow key,",keys("ArrowLeft"),"1280-after-1100"],["Shift+ArrowLeft",keys("Shift+ArrowLeft")],["End",keys("End")],["a 5px pull to the left",()=>pull(-5)],["a 40px pull to the left",()=>pull(-40)],["a pull 40px to the right and back",()=>pull(40,-40)]])await kept(how,act,{at:1100,shows:476,shot});
    for(const [how,act] of [["ArrowLeft, the grow key,",keys("ArrowLeft")],["a 5px pull to the left",()=>pull(-5)]])await kept(how,act,{at:1120,shows:496});
    for(const [how,act,shot] of [["ArrowLeft, the grow key,",keys("ArrowLeft"),"1600-after-1280"],["End",keys("End")],["a 5px pull to the left",()=>pull(-5)]])await kept(how,act,{from:1600,set:820,at:1280,shows:622,shot});
    // The window narrowed through 1120, 1100, 900 and 700px, the inspector the overlay drawer in the last two, and widened again.
    await widest(1280,622);
    for(const width of [1120,1100,900,700])await settled(width);
    expect.soft((await settled(1280)).width,"back at 1280px from 1120, 1100, 900 and 700px").toBe(622);
    // The keys and a pull that narrow the inspector at 1100px store the width they leave, as ArrowLeft then does, which 1280px shows.
    for(const [how,act,want] of [["ArrowRight",keys("ArrowRight"),460],["Shift+ArrowRight",keys("Shift+ArrowRight"),412],["Home",keys("Home"),340],["a 40px pull to the right",()=>pull(40),436],["ArrowRight and then ArrowLeft",keys("ArrowRight","ArrowLeft"),476]]){
      await widest(1280,622);await settled(1100);await toHandle();await act();
      await expect.soft.poll(async()=>(await read()).width,{message:`${how} at 1100px`}).toBe(want);
      expect.soft((await settled(1280)).width,`back at 1280px after ${how} at 1100px`).toBe(want);
    }
    // In the 1280px window: the sidebar at its narrowest (Home on its handle) and the inspector at its widest beside it (670px), and
    // then the sidebar at its widest (End), where the inspector shows 460px. The grow key, End and a 5px pull to the left there leave
    // it so, and the sidebar narrowed again gives it back its 670px.
    for(const [how,act,shot] of [["ArrowLeft, the grow key,",keys("ArrowLeft"),"sidebar-narrowed-again"],["End",keys("End")],["a 5px pull to the left",()=>pull(-5)]]){
      await settled(1280);await sidebarKey("Home");await expect.poll(async()=>(await read()).sidebar).toBe(210);
      await toHandle();await page.keyboard.press("End");await expect.poll(async()=>(await read()).width).toBe(670);
      await sidebarKey("End");await expect.poll(async()=>(await read()).sidebar).toBe(420);
      const where="with the inspector set to 670px beside the narrowest sidebar and the sidebar then widened to 420px",was=await read();
      expect.soft([was.width,was.now,was.max],`the inspector and its handle's value and maximum ${where}`).toEqual([460,460,460]);
      await toHandle();await act();
      await expect.soft.poll(async()=>{const now=await read();return [now.width,now.now]},{message:`${how} ${where} leaves the inspector as wide as it shows`,timeout:2000}).toEqual([460,460]);
      await sidebarKey("Home");
      await expect.soft.poll(async()=>(await read()).width,{message:`the sidebar narrowed again after ${how} ${where}, the inspector is the 670px it was set to`}).toBe(670);
      if(shot)await page.screenshot({path:join(shotsDir,`inspector-kept-width-${mode}-${shot}-1280.png`),animations:"disabled"});
    }
  }finally{await harness.close()}
});

// The terminal drawer has one rule for its height, as the docked inspector has for its width: it shows the height set up to the
// tallest the window lets it (the window less 260px, from 190px to 620px), which its handle says, its keys and a pull start from and
// stop at, the stylesheet caps it at, and the composer and the conversation sit above. The stylesheet capped the drawer at the window
// less 220px while the keys and a pull stopped at the window less 260px, the composer sat above the height set, uncapped, the handle
// said the height set, and App drew it again only when the window's width changed: so a drawer set to 620px in a 900px window showed
// 580px at 800px, its handle saying 620 of 620 and the composer 52px above it (12px elsewhere), up under the header, and ArrowUp, the
// grow key, or a 5px pull up took it down to 540px and stored that, so the 900px window showed 540px (UI lane D, round 10). So in a
// window 900 and then 800px tall, 1280, 1120, 1100, 900 and 700px wide, the drawer, its handle and the composer agree, the grow keys,
// End and pulls up that leave the drawer as tall as it shows keep the height set for the taller window, and ArrowDown, Home and a
// pull down store the height they leave, from which ArrowUp and a pull up raise it.
for(const mode of ["dark","light"])test(`the terminal drawer, its resize handle and the composer above it agree on its height, and a key or a pull that leaves it as tall as it shows keeps the height set for a taller window, 1280 to 700px wide and 900 and 800px tall, in ${mode} mode`,async({page})=>{
  test.setTimeout(150_000);
  const project={id:"terminal-kept-project",name:"Lane D Repository",path:process.cwd(),environmentId:null,branch:"main"};
  const threads=["Repo task one","Repo task two"].map((title,index)=>({id:"terminal-kept-thread-"+(index+1),name:title,preview:"Repo",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60-index,updatedAt:now()-index,turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Look at "+title.toLowerCase()}]},{type:"agentMessage",id:"assistant-1",text:"Looked at "+title.toLowerCase()+"."}]}]}));
  const harness=await startHarness(threads);
  try{
    await page.setViewportSize({width:1280,height:900});
    await openApp(page,{harness,threads,meta:Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}])),project,settings:{appearanceMode:mode}});
    await openThread(page,threads[0].name);
    const right=page.getByTestId("right-panel"),drawer=page.getByTestId("drawer"),handle=page.getByTestId("terminal-resizer");
    if(await right.isVisible()){await page.getByTestId("right-panel-toggle").click();await expect(right).toBeHidden()}
    await page.getByTestId("terminal-toggle").click();await expect(drawer).toBeVisible();
    // The drawer's height, its handle's value and maximum, the composer's gap above the drawer, and whether the composer is under the
    // header.
    const read=()=>page.evaluate(()=>{
      const box=selector=>document.querySelector(selector).getBoundingClientRect(),drawer=box("[data-testid=drawer]"),composer=box(".chat-workspace .composer-wrap"),header=box(".chat-workspace .workspace-header"),node=document.querySelector("[data-testid=terminal-resizer]");
      return {height:Math.round(drawer.height),now:Number(node.getAttribute("aria-valuenow")),max:Number(node.getAttribute("aria-valuemax")),gap:Math.round(drawer.top-composer.bottom),under:composer.top>=header.bottom-0.5};
    });
    // The window set to width by height, once its layout is the same two frames running.
    const settled=async(width,height)=>{
      await page.setViewportSize({width,height});let state=null;
      await expect.poll(async()=>{await settle(page);const next=await read(),same=JSON.stringify(next)===JSON.stringify(state);state=next;return same},{message:`the layout settles at ${width} by ${height}px`,intervals:[50]}).toBe(true);
      return state;
    };
    // The keyboard on the drawer's handle, as Shift+Tab from its Close terminal brings it there, and a pull on the handle, which takes
    // it, of each dy px in turn.
    const toHandle=async()=>{if(!(await handle.evaluate(node=>node===document.activeElement))){await drawer.getByRole("button",{name:"Close terminal",exact:true}).focus();await page.keyboard.press("Shift+Tab")}await expect(handle).toBeFocused()};
    const pull=async(...moves)=>{
      const grip=await handle.boundingBox(),x=grip.x+300;let y=grip.y+grip.height/2;
      await page.mouse.move(x,y);await page.mouse.down();await expect(page.locator("html"),"the pull takes the handle").toHaveClass(/layout-resizing/);
      for(const dy of moves){y+=dy;await page.mouse.move(x,y,{steps:6})}
      await page.mouse.up();
    };
    const keys=(...names)=>async()=>{for(const name of names)await page.keyboard.press(name)};
    // The drawer as the window shows it, want px tall: its handle saying so with a maximum no lower, and the composer 12px above it,
    // under the header.
    const shows=(where,state,want)=>{
      expect.soft([state.height,state.now],`the drawer's height and its handle's value ${where}`).toEqual([want,want]);
      expect.soft(state.max,`the handle's maximum ${where}`).toBeGreaterThanOrEqual(state.height);
      expect.soft([state.gap,state.under],`the composer's gap above the drawer, and the composer under the header, ${where}`).toEqual([12,true]);
    };
    shows("as it opens at 1280 by 900px",await settled(1280,900),330);
    // The drawer set as tall as it goes (End) in the 900px window: 620px.
    const tallest=async()=>{await settled(1280,900);await toHandle();await page.keyboard.press("End");await expect.poll(async()=>(await read()).height,{message:"End at 1280 by 900px"}).toBe(620)};
    // A press or a pull in the 800px window, width px wide, where the drawer set to 620px shows as tall as it goes there, 540px: it
    // leaves the drawer as tall as it shows, and the 900px window shows the 620px set again.
    const kept=async(how,act,{width=1280,shot}={})=>{
      await tallest();
      const where=`at ${width} by 800px with the drawer set to 620px at 900px`,was=await settled(width,800);
      shows(where,was,540);expect.soft(was.max,`the handle's maximum ${where}`).toBe(540);
      await toHandle();await act();
      await expect.soft.poll(async()=>{const now=await read();return [now.height,now.now]},{message:`${how} ${where} leaves the drawer as tall as it shows`,timeout:2000}).toEqual([was.height,was.height]);
      shows(`after ${how} ${where}`,await read(),540);
      if(shot)await page.screenshot({path:join(shotsDir,`terminal-kept-height-${mode}-${width}x800.png`),animations:"disabled"});
      expect.soft((await settled(1280,900)).height,`back at 1280 by 900px after ${how} ${where}, the drawer is the 620px it was set to`).toBe(620);
    };
    for(const [how,act,shot] of [["ArrowUp, the grow key,",keys("ArrowUp"),true],["Shift+ArrowUp",keys("Shift+ArrowUp")],["End",keys("End")],["a 5px pull up",()=>pull(-5)],["a 40px pull up",()=>pull(-40)],["a pull 40px down and back up",()=>pull(40,-40)]])await kept(how,act,{shot});
    for(const width of [1120,1100,900,700])await kept("ArrowUp, the grow key,",keys("ArrowUp"),{width,shot:width===700});
    await kept("a 5px pull up",()=>pull(-5),{width:900});
    // ArrowDown, Shift+ArrowDown, Home and a pull down in the 800px window store the height they leave, which the 900px window then
    // shows, and from there ArrowUp and a pull up raise the drawer.
    for(const [how,act,want] of [["ArrowDown",keys("ArrowDown"),524],["Shift+ArrowDown",keys("Shift+ArrowDown"),476],["Home",keys("Home"),190],["a 40px pull down",()=>pull(40),500],["ArrowDown and then ArrowUp",keys("ArrowDown","ArrowUp"),540],["ArrowDown twice and then a 5px pull up",async()=>{await keys("ArrowDown","ArrowDown")();await pull(-5)},513]]){
      await tallest();await settled(1280,800);await toHandle();await act();
      await expect.soft.poll(async()=>(await read()).height,{message:`${how} at 1280 by 800px`}).toBe(want);
      shows(`after ${how} at 1280 by 800px`,await read(),want);
      expect.soft((await settled(1280,900)).height,`back at 1280 by 900px after ${how} at 800px`).toBe(want);
    }
  }finally{await harness.close()}
});

// The same zoomed in, as Ctrl+= zooms the window, at 110% to 175% (UI lane D, round 10): at each zoom the inspector set to its widest
// at 1280 CSS pixels comes back so after the grow key and a 5px pull to the left at 1100 and at the first docked width over 900 CSS
// pixels (900.x, where it shows its 340px minimum: one grow key there stored 340px, which no wider window then undid), and the drawer
// set to its tallest 900 CSS pixels tall comes back so after the grow key and a 5px pull up 800 tall; and in the 1280 by 800px window
// zoomed in, a fraction of a CSS pixel tall, the drawer, its handle and the composer agree to the pixel.
for(const mode of ["dark","light"])test(`zoomed in from 110% to 175%, a key or a pull that leaves the docked inspector or the terminal drawer as it shows keeps its size for a larger window, and the drawer, its handle and the composer agree, in ${mode} mode`,async({playwright,baseURL,proxy,headless})=>{
  test.setTimeout(300_000);
  const project={id:"kept-zoom-project",name:"Lane D Repository",path:process.cwd(),environmentId:null,branch:"main"};
  const threads=["Repo task one","Repo task two"].map((title,index)=>({id:"kept-zoom-thread-"+(index+1),name:title,preview:"Repo",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60-index,updatedAt:now()-index,turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Look at "+title.toLowerCase()}]},{type:"agentMessage",id:"assistant-1",text:"Looked at "+title.toLowerCase()+"."}]}]}));
  const dir=await mkdtemp(join(tmpdir(),"trebell-kept-")),extension=join(dir,"extension");mkdirSync(extension);
  for(const [name,text] of Object.entries(ZOOM_EXTENSION))writeFileSync(join(extension,name),text);
  const harness=await startHarness(threads);let context=null;
  try{
    context=await playwright.chromium.launchPersistentContext(join(dir,"profile"),{channel:"chromium",headless,baseURL,proxy,viewport:{width:1280,height:800},args:["--disable-extensions-except="+extension,"--load-extension="+extension]});
    const zoom=context.serviceWorkers()[0]||await context.waitForEvent("serviceworker");
    const page=context.pages()[0]||await context.newPage();
    await openApp(page,{harness,threads,meta:Object.fromEntries(threads.map(thread=>[thread.id,{projectless:false,environmentId:null}])),project,settings:{appearanceMode:mode}});
    await openThread(page,threads[0].name);
    const right=page.getByTestId("right-panel"),toggle=page.getByTestId("right-panel-toggle"),panelHandle=page.getByTestId("right-panel-resizer"),drawer=page.getByTestId("drawer"),drawerHandle=page.getByTestId("terminal-resizer");
    if(!(await right.isVisible())){await toggle.click();await expect(right).toBeVisible()}
    await page.getByTestId("terminal-toggle").click();await expect(drawer).toBeVisible();
    // The window's width and height in CSS pixels, the inspector's width and its handle's value, the drawer's height and its handle's
    // value and maximum, and the composer's gap above the drawer.
    const read=()=>page.evaluate(()=>{
      const box=selector=>document.querySelector(selector).getBoundingClientRect(),value=(id,name)=>Number(document.querySelector(`[data-testid=${id}]`).getAttribute("aria-value"+name)),drawer=box("[data-testid=drawer]");
      return {width:+document.documentElement.getBoundingClientRect().width.toFixed(2),height:innerHeight,panel:Math.round(box("[data-testid=right-panel]").width),panelNow:value("right-panel-resizer","now"),drawer:+drawer.height.toFixed(2),drawerNow:value("terminal-resizer","now"),drawerMax:value("terminal-resizer","max"),gap:+(drawer.top-box(".chat-workspace .composer-wrap").bottom).toFixed(2)};
    });
    // The window set to width by height px, once its layout is the same two frames running at that size over the zoom.
    let level=1;
    const settled=async(width,height)=>{
      await page.setViewportSize({width,height});let state=null;
      await expect.poll(async()=>{await settle(page);const next=await read(),same=JSON.stringify(next)===JSON.stringify(state);state=next;return same&&Math.abs(next.width-width/level)<0.05&&next.height===Math.round(height/level)},{message:`the layout settles at ${width} by ${height}px zoomed to ${Math.round(level*100)}%`,intervals:[50]}).toBe(true);
      return state;
    };
    // The window width by height CSS pixels at the zoom.
    const css=(width,height)=>settled(Math.round(width*level),Math.round(height*level));
    // The keyboard on a handle (Shift+Tab from the inspector's first tab, or from the drawer's Close terminal), and a pull on a handle,
    // which takes it, of dx and dy px.
    const toHandle=async handle=>{
      if(await handle.evaluate(node=>node===document.activeElement))return;
      await (handle===panelHandle?right.locator(".context-panel-tab").first():drawer.getByRole("button",{name:"Close terminal",exact:true})).focus();
      await page.keyboard.press("Shift+Tab");await expect(handle).toBeFocused();
    };
    const pull=async(handle,dx,dy)=>{
      const grip=await handle.boundingBox(),x=grip.x+(handle===panelHandle?grip.width/2:300),y=grip.y+(handle===panelHandle?300:grip.height/2);
      await page.mouse.move(x,y);await page.mouse.down();await expect(page.locator("html"),"the pull takes the handle").toHaveClass(/layout-resizing/);
      await page.mouse.move(x+dx,y+dy,{steps:6});await page.mouse.up();
    };
    for(const next of [1.1,1.25,1.5,1.75]){
      // The window at 1280 by 800 CSS pixels, then zoomed in a step, as Ctrl+= zooms it.
      await page.setViewportSize({width:Math.round(1280*next),height:Math.round(800*next)});
      await zoom.evaluate(factor=>self.zoomTo(factor),next);level=next;
      await expect.poll(()=>page.evaluate(()=>devicePixelRatio),{message:`the window zooms to ${Math.round(level*100)}%`}).toBeCloseTo(level,3);
      const zoomed=`zoomed to ${Math.round(level*100)}%`,docked=Math.floor(900*level)+1;
      // The inspector set to its widest at 1280 CSS pixels (622px), and a key or a pull at 1100 (476px) or in the docked inspector's
      // narrowest window (340px) that leaves it so.
      for(const [at,shows,how,act] of [[1100,476,"ArrowLeft, the grow key,",()=>page.keyboard.press("ArrowLeft")],[1100,476,"a 5px pull to the left",()=>pull(panelHandle,-5,0)],[docked/level,340,"ArrowLeft, the grow key,",()=>page.keyboard.press("ArrowLeft")]]){
        await css(1280,800);await toHandle(panelHandle);await page.keyboard.press("End");
        await expect.poll(async()=>(await read()).panel,{message:`End at 1280 CSS pixels ${zoomed}`}).toBe(622);
        const where=`at ${+at.toFixed(2)} CSS pixels ${zoomed} with the inspector set to 622px at 1280`,was=at===1100?await css(1100,800):await settled(docked,Math.round(800*level));
        expect.soft([was.panel,was.panelNow],`the inspector and its handle's value ${where}`).toEqual([shows,shows]);
        await toHandle(panelHandle);await act();
        await expect.soft.poll(async()=>{const now=await read();return [now.panel,now.panelNow]},{message:`${how} ${where} leaves the inspector as wide as it shows`,timeout:2000}).toEqual([shows,shows]);
        expect.soft((await css(1280,800)).panel,`back at 1280 CSS pixels after ${how} ${where}, the inspector is the 622px it was set to`).toBe(622);
      }
      // The drawer set to its tallest 900 CSS pixels tall (620px), and a key or a pull 800 tall (540px) that leaves it so.
      for(const [how,act] of [["ArrowUp, the grow key,",()=>page.keyboard.press("ArrowUp")],["a 5px pull up",()=>pull(drawerHandle,0,-5)]]){
        await css(1280,900);await toHandle(drawerHandle);await page.keyboard.press("End");
        await expect.poll(async()=>Math.round((await read()).drawer),{message:`End 900 CSS pixels tall ${zoomed}`}).toBe(620);
        const where=`800 CSS pixels tall ${zoomed} with the drawer set to 620px 900 tall`,was=await css(1280,800),shown=Math.round(was.drawer);
        expect.soft([shown,was.drawerNow,was.drawerMax,Math.round(was.gap)],`the drawer, its handle's value and maximum and the composer's gap above it ${where}`).toEqual([540,540,540,12]);
        await toHandle(drawerHandle);await act();
        await expect.soft.poll(async()=>{const now=await read();return [Math.round(now.drawer),now.drawerNow]},{message:`${how} ${where} leaves the drawer as tall as it shows`,timeout:2000}).toEqual([shown,shown]);
        expect.soft(Math.round((await css(1280,900)).drawer),`back 900 CSS pixels tall after ${how} ${where}, the drawer is the 620px it was set to`).toBe(620);
      }
      // The 1280 by 800px window zoomed in, a fraction of a CSS pixel tall, with the drawer set to 620px: the drawer as tall as the
      // window less 260px, its handle saying so, and the composer 12px above it, each to the pixel; the grow key leaves it so.
      const fraction=await settled(1280,800),where=`in the 1280 by 800px window ${zoomed} (${(800/level).toFixed(2)} CSS pixels tall)`;
      expect.soft(Math.abs(fraction.drawer-fraction.drawerNow),`the drawer's height against its handle's value ${where}: ${fraction.drawer} and ${fraction.drawerNow}`).toBeLessThanOrEqual(1);
      expect.soft(fraction.drawerMax,`the handle's maximum ${where}`).toBeGreaterThanOrEqual(fraction.drawer-1);
      expect.soft(Math.abs(fraction.gap-12),`the composer's gap above the drawer ${where}: ${fraction.gap}px`).toBeLessThanOrEqual(1);
      await toHandle(drawerHandle);await page.keyboard.press("ArrowUp");
      await expect.soft.poll(async()=>(await read()).drawerNow,{message:`ArrowUp ${where} leaves the drawer as tall as it shows`,timeout:2000}).toBe(fraction.drawerNow);
      if(level===1.25)await page.screenshot({path:join(shotsDir,`terminal-kept-height-zoom-125-${mode}-1280x800.png`),animations:"disabled"});
    }
  }finally{await context?.close();await harness.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
});

// The composer stays between the header and the terminal drawer at every height the drawer's handle allows (UI lane C, round 11).
// The drawer's tallest was the window less 260px whatever the composer above it needed, and the composer, which stands 12px above
// the drawer and grows up with its draft (up to 160px of it), had no top: so with the drawer at its tallest a six-line draft took the
// composer 53px over the header at 1280 by 800 in the desktop app (its 32px window bar above the header), where a press on the title
// went to the draft, its controls wrapped in two rows beside the inspector at its widest took it 9px into the header with no draft,
// and both took it past the window's top. So in the desktop app and in a browser, in a window 1280 by 800, then 1100 by 800, 600
// tall and the desktop's smallest, 1180 by 720, beside the inspector closed and at its widest, with no draft and a six-line one, and
// with two files attached: the drawer at its tallest and its handle agree, the composer sits 12px above it and under the header with
// its shelf, every control of the header is drawn where it is and the title can be pressed, and a draft longer than the composer has
// room for scrolls in it, with what was typed last in view; the grow key there leaves the drawer so, and it is as tall as it was
// again once the files are taken off and the inspector closes.
// And (repair of lane B, round 11) the rows of the composer that grow while it is held under the header take their room from the
// drawer, not from the draft, which keeps a line: a pull request attached from the Git tab, whose chip's row stands over the draft,
// and the note under it that dictation was refused, the microphone blocked, each squeezed the draft to its padding beside the
// inspector at its widest in the desktop app, with the drawer left at its tallest (the composer heard its room only when its own box
// changed size, and a box held under the header keeps its size); the note of a send the harness refused, which the send's own
// changes to the composer brought in, takes its four lines there too. A draft given less room shows its end, where it was typed, as
// it does while it is typed: a six-line draft typed before End on the drawer's handle, or before the inspector went to its widest,
// was shown from its first lines, its last ones out of view.
// The header, the composer and its draft, the drawer and its handle, and the header's controls a press at their middle misses (what is
// drawn there is not the control: the composer over it). The draft: a line of it with its padding (line), and how far the letters of
// its last line stand over what it shows (top) and reach under it (end), its line less the space over and under the letters, and the
// padding under it.
const readRoom=page=>page.evaluate(()=>{
  const box=node=>{const rect=node.getBoundingClientRect();return {top:+rect.top.toFixed(2),bottom:+rect.bottom.toFixed(2),height:+rect.height.toFixed(2)}};
  const header=document.querySelector(".chat-workspace .workspace-header"),wrap=document.querySelector(".chat-workspace .composer-wrap"),draft=wrap.querySelector("textarea"),node=document.querySelector("[data-testid=terminal-resizer]"),style=getComputedStyle(draft);
  const missed=[...header.querySelectorAll("button,select")].filter(control=>{const rect=control.getBoundingClientRect();return rect.width>0&&rect.height>0&&getComputedStyle(control).visibility!=="hidden"&&!control.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2))}).map(control=>control.getAttribute("aria-label")||control.textContent.trim());
  const shelf=wrap.querySelector(".attachment-shelf"),line=parseFloat(style.lineHeight),lead=(line-parseFloat(style.fontSize))/2,over=parseFloat(style.paddingTop),under=parseFloat(style.paddingBottom);
  return {header:box(header),composer:box(wrap),shelf:shelf.getClientRects().length?box(shelf):null,drawer:box(document.querySelector("[data-testid=drawer]")),now:Number(node.getAttribute("aria-valuenow")),max:Number(node.getAttribute("aria-valuemax")),missed,below:wrap.scrollHeight-wrap.clientHeight,
    draft:{holds:draft.scrollHeight,shows:draft.clientHeight,line:Math.floor(over+line+under),scrolls:style.overflowY,top:Math.round(draft.scrollTop-(draft.scrollHeight-under-line+lead)),end:Math.round(draft.scrollHeight-draft.clientHeight-draft.scrollTop-under-lead)}};
});
// The project, the two threads (the first one linked to two pull requests) and the six lines of draft of the tests below.
const roomProject={id:"room-project",name:"Billing reconciliation service with a very long project name",path:process.cwd(),environmentId:null,branch:"feature/reconcile-refunds-in-the-ledger-export",scripts:[{id:"dev-server",name:"Start the billing dev server",command:"npm run dev -- --port 4173"}],preferredScriptId:"dev-server"};
const roomThreads=()=>["Repo task number one","Repo task number two"].map((title,index)=>({id:"room-thread-"+(index+1),name:title,preview:"Repo",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60-index,updatedAt:now()-index,turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Look at "+title.toLowerCase()}]},{type:"agentMessage",id:"assistant-1",text:"Looked at "+title.toLowerCase()+"."}]}]}));
const roomPrs=[12345,12346].map((number,index)=>({url:"https://github.com/acme/billing/pull/"+number,number,title:"Refund fix "+index,state:"open"}));
const roomMeta=threads=>({[threads[0].id]:{projectless:false,environmentId:null,linkedPullRequests:roomPrs},[threads[1].id]:{projectless:false,environmentId:null}});
const roomLines=["Plan for the export fix:","1. read the ledger export","2. find the double count","3. write a test for refunds","4. fix the sum","5. run the suite"];
// The desktop app gives the page its bridge (here its Open-in only), and the shell its 32px window bar above the header.
const asDesktop=page=>page.addInitScript(()=>Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{openIn:{list:async()=>({editors:[{id:"vscode",label:"Visual Studio Code"}]}),open:async()=>{}}}}));
// Six lines typed into the composer as a person types them, Shift+Enter between them.
async function writeRoomDraft(page){
  const composer=page.getByTestId("composer");await composer.click();
  for(const [index,line] of roomLines.entries()){if(index)await page.keyboard.press("Shift+Enter");await page.keyboard.type(line,{delay:5})}
  await expect(composer).toHaveValue(roomLines.join("\n"));
}
// The drawer's handle given the keyboard, as Shift+Tab from the drawer's Close terminal brings it there.
async function focusTerminalHandle(page){
  const handle=page.getByTestId("terminal-resizer");
  if(!(await handle.evaluate(node=>node===document.activeElement))){await page.getByTestId("drawer").getByRole("button",{name:"Close terminal",exact:true}).focus();await page.keyboard.press("Shift+Tab")}
  await expect(handle).toBeFocused();
}
for(const [shell,mode] of [["desktop","dark"],["desktop","light"],["browser","dark"],["browser","light"]])test(`with the terminal drawer at its tallest the composer stays between the header and the drawer, with no draft and a six-line one, beside the inspector closed and at its widest, at 1280 and 1100 by 800, 600 tall and 1180 by 720, in the ${shell} shell in ${mode} mode`,async({page})=>{
  test.setTimeout(240_000);
  if(shell==="desktop")await asDesktop(page);
  // The browser's speech recognition, which refuses to start, the microphone blocked (as composer-inputs.spec.js scripts it).
  await page.addInitScript(()=>{class Recognition{start(){setTimeout(()=>{this.onerror?.({error:"not-allowed"});this.onend?.()},30)}stop(){setTimeout(()=>this.onend?.(),30)}abort(){this.stop()}}window.SpeechRecognition=Recognition;window.webkitSpeechRecognition=Recognition});
  const project=roomProject,threads=roomThreads();
  // The harness refuses a send while refusing is set, with a reason long enough to take the four lines the composer's note shows.
  let refusing=false;
  const refusal="The provider refused the turn: the monthly token quota of the billing reconciliation project is used up, and it renews on the first of next month or as soon as an administrator raises it in the provider's console";
  const harness=await startHarness(threads,{respond:message=>refusing&&message.method==="turn/start"?{rpcError:{code:-32000,message:refusal}}:undefined});
  // The code host behind the Git tab, which lists one of the thread's pull requests; its Attach puts it in the composer as a chip.
  const hosted={provider:"github",number:12345,title:"Refund fix 0",state:"OPEN",url:roomPrs[0].url,headRefName:"fix/refund-double-count",baseRefName:"main",identity:{provider:"github",host:"github.com",repository:"acme/billing",number:12345}};
  await page.route(/\/api\/source-control\//,route=>{
    const path=new URL(route.request().url()).pathname.replace(/^.*\/api\/source-control\//,""),json=value=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
    if(path==="diagnostics")return json({selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:{}}});
    if(path==="prs")return json({ok:true,provider:"github",capabilities:{},items:[hosted]});
    if(path==="pr-detail")return json({ok:true,provider:"github",capabilities:{},item:{body:"",comments:[],reviews:[],files:[],statusCheckRollup:[],...hosted}});
    if(path==="pr-viewed")return json({ok:true,provider:"github",store:"host",files:[]});
    // The thread's links as they are, so the Git tab's sync of them on opening leaves the header's chips as they are.
    if(path==="thread-link")return json({threads:[],links:roomPrs});
    if(path==="settlements")return json({enabled:false,items:[]});
    return json({items:[]});
  });
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads,meta:roomMeta(threads),project,settings:{appearanceMode:mode}});
    await openThread(page,threads[0].name);
    const header=page.locator(".chat-workspace .workspace-header"),right=page.getByTestId("right-panel"),drawer=page.getByTestId("drawer"),composer=page.getByTestId("composer"),question=page.locator("dialog.inspector-text-prompt");
    if(await right.isVisible()){await page.getByTestId("right-panel-toggle").click();await expect(right).toBeHidden()}
    const read=()=>readRoom(page);
    // The drawer at its tallest and its handle agree, the composer sits 12px above it and under the header with its shelf of
    // attachments, of which they cover no control, nothing of the composer hangs out of its box, its draft shows a line of it at least,
    // and the last line, where it was typed, in its view, and a draft it shows in part scrolls; read once the layout is the same two
    // frames running.
    const between=async where=>{
      let state=null;
      await expect.poll(async()=>{await settle(page);const next=await read(),same=JSON.stringify(next)===JSON.stringify(state);state=next;return same},{message:`the layout settles ${where}`,intervals:[50]}).toBe(true);
      expect.soft([Math.round(state.drawer.height),state.max],`the drawer's height and its handle's maximum ${where}`).toEqual([state.now,state.now]);
      expect.soft(Math.round(state.drawer.top-state.composer.bottom),`the composer's gap above the drawer ${where}`).toBe(12);
      expect.soft(Math.min(state.composer.top,state.shelf?.top??Infinity),`the top of the composer and its shelf against the header's foot, at ${state.header.bottom}px, ${where}`).toBeGreaterThanOrEqual(state.header.bottom);
      expect.soft(state.missed,`the header's controls a press at their middle misses ${where}`).toEqual([]);
      expect.soft(state.below,`what the composer holds below its box ${where}`).toBeLessThanOrEqual(1);
      expect.soft(state.draft.shows,`the height the draft shows ${where}, against a line of it with its padding, ${state.draft.line}px`).toBeGreaterThanOrEqual(state.draft.line);
      expect.soft(state.draft.top,`how far the letters of the draft's last line, where it was typed, stand over what it shows ${where}`).toBeLessThanOrEqual(1);
      expect.soft(state.draft.end,`how far the letters of the draft's last line, where it was typed, reach under what it shows ${where}`).toBeLessThanOrEqual(1);
      if(state.draft.holds>state.draft.shows+1)expect.soft(state.draft.scrolls,`the draft the composer shows in part ${where} scrolls`).toBe("auto");
      return state;
    };
    const type=async where=>{await writeRoomDraft(page);return between(where)};
    const clear=async()=>{await composer.click();await page.keyboard.press("Control+a");await page.keyboard.press("Delete");await expect(composer).toHaveValue("")};
    // The title pressed at its middle as a person presses it: Trebell asks for the thread's new name, and Escape leaves it.
    const pressTitle=async where=>{
      const title=await header.locator(".thread-title-button").boundingBox();
      await page.mouse.click(title.x+title.width/2,title.y+title.height/2);
      await expect.soft(question,`a press on the title ${where} asks for the thread's new name`).toBeVisible();
      if(await question.isVisible()){await page.keyboard.press("Escape");await expect(question).toHaveCount(0)}
    };
    // The drawer opened from the header (or More actions, where the header folded its button), a six-line draft typed while it is as
    // tall as it opens, which leaves the composer room for all of it, and the drawer then set to its tallest from the keyboard on its
    // handle: the window less 260px, where the composer has room, and the draft, given less of it, still shows what was typed last.
    const toggle=page.getByTestId("terminal-toggle");
    if(await toggle.isVisible())await toggle.click();
    else{await header.getByRole("button",{name:"More actions",exact:true}).click();await page.getByTestId("header-overflow-menu").getByRole("button",{name:"Terminal"}).click()}
    await expect(drawer).toBeVisible();
    const toHandle=()=>focusTerminalHandle(page);
    await writeRoomDraft(page);
    await toHandle();await page.keyboard.press("End");
    await expect.poll(async()=>(await read()).now,{message:"End takes the drawer to its tallest at 1280 by 800"}).toBe(540);
    await between("at 1280 by 800 after End with a six-line draft typed before it");
    await clear();
    await between("at 1280 by 800 with no draft");
    await type("at 1280 by 800 with a six-line draft");
    await pressTitle("at 1280 by 800 with a six-line draft");
    await page.screenshot({path:join(shotsDir,`composer-under-header-${shell}-${mode}-1280x800-draft.png`),animations:"disabled"});
    // The inspector opened and set to its widest from the keyboard on its handle (Shift+Tab from its first tab): the main column is
    // 400px, where the composer's controls take two rows.
    await page.getByTestId("right-panel-toggle").click();await expect(right).toBeVisible();
    await right.locator(".context-panel-tab").first().focus();await page.keyboard.press("Shift+Tab");await expect(page.getByTestId("right-panel-resizer")).toBeFocused();
    await page.keyboard.press("End");
    await expect.poll(async()=>Math.round((await right.boundingBox()).width),{message:"End takes the inspector to its widest at 1280 by 800"}).toBe(1280-258-400);
    await between("at 1280 by 800 beside the inspector at its widest with the six-line draft");
    await pressTitle("beside the inspector at its widest with the six-line draft");
    await page.screenshot({path:join(shotsDir,`composer-under-header-${shell}-${mode}-1280x800-inspector-draft.png`),animations:"disabled"});
    await clear();
    await between("at 1280 by 800 beside the inspector at its widest with no draft");
    // The grow key on the drawer's handle at its tallest leaves the drawer as tall as it shows.
    const tallest=(await read()).now;
    await toHandle();await page.keyboard.press("ArrowUp");
    await expect.soft.poll(async()=>(await read()).now,{message:"ArrowUp at the drawer's tallest beside the inspector at its widest leaves it",timeout:2000}).toBe(tallest);
    await between("after ArrowUp at the drawer's tallest beside the inspector at its widest");
    // Dictation refused, the microphone blocked: the composer's note says so under the draft, and the drawer gives way for it, leaving
    // the draft its line (in the desktop app the composer was held under the header, where any row that grows takes the drawer's
    // room; in a browser it had 11px to spare). A key typed takes the note off, and the drawer is as tall as it was again.
    const note=page.getByTestId("composer-alert");
    await page.getByRole("button",{name:"Voice dictation",exact:true}).click();
    await expect(note).toHaveText("The microphone is blocked. Allow microphone access for Trebell Code to dictate.");
    const blocked=await between("beside the inspector at its widest with the note that the microphone is blocked");
    if(shell==="desktop")expect.soft(blocked.now,"the drawer beside the inspector at its widest with the note that the microphone is blocked, against its tallest without it").toBeLessThan(tallest);
    await page.screenshot({path:join(shotsDir,`composer-under-header-${shell}-${mode}-1280x800-inspector-dictation.png`),animations:"disabled"});
    await composer.focus();await page.keyboard.type("x",{delay:5});await expect(note).toHaveCount(0);
    await expect.poll(async()=>(await read()).now,{message:"the drawer at its tallest beside the inspector at its widest once the dictation note is off"}).toBe(tallest);
    await between("beside the inspector at its widest once the dictation note is off");
    await clear();
    // A send the harness refuses: the composer's note says why under the draft it keeps, in the four lines it shows, and the drawer
    // gives way for them, leaving the draft its line. A key typed takes the note off, and the drawer is as tall as it was again.
    refusing=true;
    await composer.click();await page.keyboard.type("Ship the export fix",{delay:5});await page.keyboard.press("Enter");
    await expect(note).toContainText("Not sent: The provider refused the turn");await expect(composer).toHaveValue("Ship the export fix");
    refusing=false;
    expect.soft((await between("beside the inspector at its widest with the note of a refused send")).now,"the drawer beside the inspector at its widest with the note of a refused send, against its tallest without it").toBeLessThan(tallest);
    await page.screenshot({path:join(shotsDir,`composer-under-header-${shell}-${mode}-1280x800-inspector-refused.png`),animations:"disabled"});
    await composer.focus();await page.keyboard.type(".",{delay:5});await expect(note).toHaveCount(0);
    await expect.poll(async()=>(await read()).now,{message:"the drawer at its tallest beside the inspector at its widest once the note is off"}).toBe(tallest);
    await between("beside the inspector at its widest once the note is off");
    await clear();
    // A pull request attached from the Git tab: its chip's row stands in the composer over the draft, and the drawer gives way for it,
    // leaving the draft its line. With the chip taken off the drawer is as tall as it was again.
    await right.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
    const pulls=right.locator(".pr-card"),chip=page.getByTestId("context-chip");
    await pulls.locator(".pr-list").getByRole("button",{name:/#12345 Refund fix 0/}).click();await expect(pulls.locator(".pr-detail h3")).toHaveText("#12345 Refund fix 0");
    await pulls.locator(".pr-actions").getByRole("button",{name:"Attach",exact:true}).click();
    await expect(chip).toHaveText([/PR #12345\s*Refund fix 0/]);
    expect.soft((await between("beside the inspector at its widest with a pull request attached")).now,"the drawer beside the inspector at its widest with a pull request attached, against its tallest without it").toBeLessThan(tallest);
    await page.screenshot({path:join(shotsDir,`composer-under-header-${shell}-${mode}-1280x800-inspector-pull-request.png`),animations:"disabled"});
    await chip.getByRole("button",{name:"Remove context"}).click();await expect(chip).toHaveCount(0);
    await expect.poll(async()=>(await read()).now,{message:"the drawer at its tallest beside the inspector at its widest once the pull request is taken off"}).toBe(tallest);
    await between("beside the inspector at its widest once the pull request is taken off");
    // Two files attached from the composer's Attach files: the shelf that shows them stands on the composer, under the header too, and
    // the drawer gives way while they are there.
    const dir=await mkdtemp(join(tmpdir(),"trebell-room-")),files=["ledger-export.csv","refunds.log"].map(name=>join(dir,name));
    try{
      for(const file of files)writeFileSync(file,"refund 1\n");
      const [chooser]=await Promise.all([page.waitForEvent("filechooser"),page.getByRole("button",{name:"Attach files",exact:true}).click()]);await chooser.setFiles(files);
      await expect(page.locator(".attachment-shelf > span:not(.uploading)")).toHaveCount(2);
      await between("beside the inspector at its widest with two files attached");
      for(let left=2;left>0;left--){await page.locator(".attachment-shelf > span button").first().click();await expect(page.locator(".attachment-shelf > span")).toHaveCount(left-1)}
      await expect.poll(async()=>(await read()).now,{message:"the drawer at its tallest beside the inspector at its widest once the files are taken off"}).toBe(tallest);
    }finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
    for(const [width,height] of [[1100,800],[1280,600],[1180,720]]){
      await page.setViewportSize({width,height});
      await between(`at ${width} by ${height} beside the inspector at its widest with no draft`);
      await type(`at ${width} by ${height} beside the inspector at its widest with a six-line draft`);
      if(width===1180)await pressTitle(`at 1180 by 720 beside the inspector at its widest with the six-line draft`);
      await clear();
    }
    // The inspector closed: the drawer is as tall as it was set at 1280 by 800.
    await page.setViewportSize({width:1280,height:800});
    await page.getByTestId("right-panel-toggle").click();await expect(right).toBeHidden();
    await expect.poll(async()=>(await read()).now,{message:"the drawer at 1280 by 800 once the inspector closes"}).toBe(540);
    await between("at 1280 by 800 once the inspector closes");
  }finally{await harness.close()}
});

// With the panels animating (Settings > Appearance, here at its longest, 400ms) the composer stays under the header while the terminal
// drawer slides from its tallest to its shortest and back (repair of lane B, round 11). The composer's foot slides with the drawer's
// top, and the room the header leaves it only came with the slide's end: set to its shortest with Home, the drawer gave the six-line
// draft it held to a few lines its whole height at once, while the composer's foot still stood where the drawer's top had been, so
// for the first part of the slide the composer covered the title and the header's actions in the desktop app (its top at 31 against
// the header's foot at 84, at 1280 by 800) and, beside the inspector at its widest, reached past the window's top. Each slide is read
// at 21 points of its way, the composer's transitions paused and set there, and the draft, given less room, shows what was typed last.
for(const [shell,mode] of [["desktop","dark"],["browser","light"]])test(`with the panels animating, the composer stays under the header while the terminal drawer slides from its tallest to its shortest and back with a six-line draft, beside the inspector closed and at its widest, in the ${shell} shell in ${mode} mode`,async({page})=>{
  test.setTimeout(150_000);
  if(shell==="desktop")await asDesktop(page);
  const threads=roomThreads(),harness=await startHarness(threads);
  try{
    await page.setViewportSize({width:1280,height:800});
    await openApp(page,{harness,threads,meta:roomMeta(threads),project:roomProject,settings:{appearanceMode:mode,panelAnimationMs:400}});
    await openThread(page,threads[0].name);
    const right=page.getByTestId("right-panel"),drawer=page.getByTestId("drawer");
    await expect.poll(()=>page.evaluate(()=>document.documentElement.style.getPropertyValue("--panel-animation-ms")),{message:"the panels animate over 400ms"}).toBe("400ms");
    // Every transition on the page ended, and two frames drawn after it.
    const still=async where=>{await expect.poll(()=>page.evaluate(()=>document.getAnimations().filter(animation=>animation instanceof CSSTransition&&animation.playState==="running").length),{message:`the transitions end ${where}`}).toBe(0);await settle(page);await settle(page)};
    if(await right.isVisible()){await page.getByTestId("right-panel-toggle").click();await expect(right).toBeHidden();await still("as the inspector closes")}
    // A key on the drawer's handle, and the composer's slide after it read at 21 points of its way, from its start to its end: each
    // frame from the key on looks for its transitions and pauses them as they start (so a slow round trip cannot let one end unread),
    // and they are set at each point, and let finish after.
    const slide=async(key,where)=>{
      await page.evaluate(()=>{
        const wrap=document.querySelector(".chat-workspace .composer-wrap");window.__slide=null;
        let frames=0;const watch=()=>{const moving=wrap.getAnimations().filter(animation=>animation instanceof CSSTransition&&["bottom","max-height"].includes(animation.transitionProperty));if(moving.some(animation=>animation.transitionProperty==="bottom")){moving.forEach(animation=>animation.pause());window.__slide=moving}else if(++frames<600)requestAnimationFrame(watch)};
        requestAnimationFrame(watch);
      });
      await page.keyboard.press(key);
      await expect.poll(()=>page.evaluate(()=>Boolean(window.__slide)),{message:`the composer's foot slides ${where}`}).toBe(true);
      const slid=await page.evaluate(()=>{
        const wrap=document.querySelector(".chat-workspace .composer-wrap"),header=document.querySelector(".chat-workspace .workspace-header"),moving=window.__slide,samples=[];
        for(let step=0;step<=20;step++){const at=step*20;moving.forEach(animation=>{animation.currentTime=at});const rect=wrap.getBoundingClientRect();samples.push({at,top:+rect.top.toFixed(2),bottom:+rect.bottom.toFixed(2),header:+header.getBoundingClientRect().bottom.toFixed(2)})}
        moving.forEach(animation=>animation.finish());window.__slide=null;
        return {properties:moving.map(animation=>animation.transitionProperty).sort(),samples};
      });
      expect(slid.samples.at(-1).bottom,`the composer's foot at the slide's end, against its start, ${where}`).not.toBe(slid.samples[0].bottom);
      const highest=slid.samples.reduce((top,sample)=>sample.top<top.top?sample:top);
      expect.soft(highest.top,`the composer's top at its highest through the slide ${where}, ${highest.at}ms in, its ${slid.properties.join(" and ")} sliding, against the header's foot at ${highest.header}px`).toBeGreaterThanOrEqual(highest.header);
      await still(where);
    };
    // The draft shows a line of it at least, and the last line, where it was typed.
    const shown=async where=>{
      const {draft}=await readRoom(page);
      expect.soft(draft.shows,`the height the draft shows ${where}, against a line of it with its padding, ${draft.line}px`).toBeGreaterThanOrEqual(draft.line);
      expect.soft(draft.top,`how far the letters of the draft's last line, where it was typed, stand over what it shows ${where}`).toBeLessThanOrEqual(1);
      expect.soft(draft.end,`how far the letters of the draft's last line, where it was typed, reach under what it shows ${where}`).toBeLessThanOrEqual(1);
    };
    const toggle=page.getByTestId("terminal-toggle");
    if(await toggle.isVisible())await toggle.click();
    else{await page.locator(".chat-workspace .workspace-header").getByRole("button",{name:"More actions",exact:true}).click();await page.getByTestId("header-overflow-menu").getByRole("button",{name:"Terminal"}).click()}
    await expect(drawer).toBeVisible();await still("as the drawer opens");
    await focusTerminalHandle(page);await page.keyboard.press("End");
    await expect.poll(async()=>(await readRoom(page)).now,{message:"End takes the drawer to its tallest at 1280 by 800"}).toBe(540);await still("at the drawer's tallest");
    await writeRoomDraft(page);await still("with the six-line draft typed");
    await shown("at the drawer's tallest with the six-line draft");
    await focusTerminalHandle(page);
    await slide("Home","as the drawer goes from its tallest to its shortest with the six-line draft");
    await slide("End","as the drawer goes from its shortest to its tallest with the six-line draft");
    await shown("once the drawer has slid to its tallest with the six-line draft");
    // The inspector opened and set to its widest from the keyboard on its handle: the composer's controls take two rows.
    await page.getByTestId("right-panel-toggle").click();await expect(right).toBeVisible();
    await right.locator(".context-panel-tab").first().focus();await page.keyboard.press("Shift+Tab");await expect(page.getByTestId("right-panel-resizer")).toBeFocused();
    await page.keyboard.press("End");
    await expect.poll(async()=>Math.round((await right.boundingBox()).width),{message:"End takes the inspector to its widest at 1280 by 800"}).toBe(1280-258-400);
    await still("beside the inspector at its widest");
    await shown("beside the inspector at its widest with the six-line draft");
    await focusTerminalHandle(page);
    await slide("Home","beside the inspector at its widest as the drawer goes from its tallest to its shortest with the six-line draft");
    await slide("End","beside the inspector at its widest as the drawer goes from its shortest to its tallest with the six-line draft");
    await shown("beside the inspector at its widest once the drawer has slid to its tallest with the six-line draft");
    await page.screenshot({path:join(shotsDir,`composer-slides-under-header-${shell}-${mode}-1280x800-inspector-draft.png`),animations:"disabled"});
  }finally{await harness.close()}
});

// The stylesheet caps the terminal drawer at the window less the room the composer needs now, the room its handle, its keys and a
// pull stop at (UI lane D, round 12). App gave the stylesheet that room only as it drew, and a room that shrank while the drawer's
// tallest stayed 620px drew nothing: at 1280 by 1000, with the drawer at its tallest beside the inspector at its widest and two files
// attached, the files taken off or the inspector closed left the stylesheet the room the composer had needed, so a window then made
// 890px tall showed the drawer at 609px under its handle's 620 of 620, the composer 23px above it (577px and 55px in the desktop app),
// until a key typed in the composer drew App again. So in a browser and in the desktop app, the files taken off with their x, or the
// inspector closed with its button or Ctrl+Alt+B, or narrowed with Home or a quick pull on its handle, at 1000 tall, and the window
// then made shorter where the drawer's tallest is still 620px (890px, and 920px in the desktop app, where with its window bar the
// composer beside the inspector at its widest still needs 281px once its files are taken off): the drawer keeps its 620px, as its
// handle says, and the composer sits 12px above it, before and after the grow key on the handle.
for(const [shell,mode] of [["browser","dark"],["browser","light"],["desktop","dark"],["desktop","light"]])test(`after the composer's room shrinks in a window 1000px tall, its files taken off or the inspector closed or narrowed, a shorter window shows the terminal drawer as tall as its handle says with the composer 12px above it, in the ${shell} shell in ${mode} mode`,async({page})=>{
  test.setTimeout(180_000);
  if(shell==="desktop")await asDesktop(page);
  const threads=roomThreads(),harness=await startHarness(threads);
  const dir=await mkdtemp(join(tmpdir(),"trebell-room-")),files=["ledger-export.csv","refunds.log"].map(name=>join(dir,name));
  try{
    for(const file of files)writeFileSync(file,"refund 1\n");
    await page.setViewportSize({width:1280,height:1000});
    await openApp(page,{harness,threads,meta:roomMeta(threads),project:roomProject,settings:{appearanceMode:mode}});
    await openThread(page,threads[0].name);
    const right=page.getByTestId("right-panel"),panelToggle=page.getByTestId("right-panel-toggle"),panelHandle=page.getByTestId("right-panel-resizer"),drawer=page.getByTestId("drawer"),chips=page.locator(".attachment-shelf > span");
    if(await right.isVisible()){await panelToggle.click();await expect(right).toBeHidden()}
    const toggle=page.getByTestId("terminal-toggle");
    if(await toggle.isVisible())await toggle.click();
    else{await page.locator(".chat-workspace .workspace-header").getByRole("button",{name:"More actions",exact:true}).click();await page.getByTestId("header-overflow-menu").getByRole("button",{name:"Terminal"}).click()}
    await expect(drawer).toBeVisible();
    // The inspector's handle given the keyboard, as Shift+Tab from its first tab brings it there.
    const toPanelHandle=async()=>{if(!(await panelHandle.evaluate(node=>node===document.activeElement))){await right.locator(".context-panel-tab").first().focus();await page.keyboard.press("Shift+Tab")}await expect(panelHandle).toBeFocused()};
    // Once the layout is the same two frames running: the drawer want px tall, its handle's value and maximum saying so, and the
    // composer 12px above it, under the header.
    const agree=async(where,want)=>{
      let state=null;
      await expect.poll(async()=>{await settle(page);const next=await readRoom(page),same=JSON.stringify(next)===JSON.stringify(state);state=next;return same},{message:`the layout settles ${where}`,intervals:[50]}).toBe(true);
      expect.soft([Math.round(state.drawer.height),state.now,state.max],`the drawer's height and its handle's value and maximum ${where}`).toEqual([want,want,want]);
      expect.soft(Math.round(state.drawer.top-state.composer.bottom),`the composer's gap above the drawer ${where}`).toBe(12);
      expect.soft(Math.min(state.composer.top,state.shelf?.top??Infinity),`the top of the composer and its shelf against the header's foot, at ${state.header.bottom}px, ${where}`).toBeGreaterThanOrEqual(state.header.bottom);
    };
    const shorter=shell==="desktop"?920:890;
    for(const [how,act,name] of [
      ["the files taken off with their x",async()=>{for(let left=2;left>0;left--){await page.locator(".attachment-shelf > span button").first().click();await expect(chips).toHaveCount(left-1)}},"files-off"],
      ["the inspector closed with its button in the header",async()=>{await panelToggle.click();await expect(right).toBeHidden()},"inspector-closed"],
      ["the inspector closed with Ctrl+Alt+B",async()=>{await right.locator(".context-panel-tab").first().focus();await page.keyboard.press(process.platform==="darwin"?"Meta+Alt+B":"Control+Alt+B");await expect(right).toBeHidden()},"inspector-closed-keys"],
      ["the inspector set to its narrowest with Home on its handle",async()=>{await toPanelHandle();await page.keyboard.press("Home");await expect.poll(async()=>Math.round((await right.boundingBox()).width),{message:"Home takes the inspector to its narrowest"}).toBe(340)},"inspector-narrowest"],
      // A quick pull: the handle taken, then let go 400px to the right (a pull whose last moves come after the composer's controls go
      // back to one row draws App again on its own).
      ["the inspector narrowed with a quick pull on its handle",async()=>{
        const grip=await panelHandle.boundingBox(),x=grip.x+grip.width/2,y=grip.y+300;
        await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+5,y);await expect(page.locator("html"),"the pull takes the handle").toHaveClass(/layout-resizing/);
        await page.mouse.move(x+400,y);await page.mouse.up();
        await expect.poll(async()=>Math.round((await right.boundingBox()).width),{message:"the pull takes the inspector to its narrowest"}).toBe(340);
      },"inspector-pulled"],
    ]){
      // At 1280 by 1000 the inspector opened and set to its widest from the keyboard on its handle, where the composer's controls take
      // two rows in the 400px main column, two files attached from Attach files, and the drawer set to its tallest with Home and End on
      // its handle.
      await page.setViewportSize({width:1280,height:1000});
      if(!(await right.isVisible())){await panelToggle.click();await expect(right).toBeVisible()}
      await toPanelHandle();await page.keyboard.press("End");
      await expect.poll(async()=>Math.round((await right.boundingBox()).width),{message:`End takes the inspector to its widest at 1280 by 1000 before ${how}`}).toBe(1280-258-400);
      if(!(await chips.count())){const [chooser]=await Promise.all([page.waitForEvent("filechooser"),page.getByRole("button",{name:"Attach files",exact:true}).click()]);await chooser.setFiles(files)}
      await expect(page.locator(".attachment-shelf > span:not(.uploading)")).toHaveCount(2);
      await focusTerminalHandle(page);await page.keyboard.press("Home");await page.keyboard.press("End");
      await agree(`at 1280 by 1000 with the drawer at its tallest beside the inspector at its widest and two files attached, before ${how}`,620);
      await act();
      await agree(`at 1280 by 1000 after ${how}`,620);
      await page.setViewportSize({width:1280,height:shorter});
      await agree(`at 1280 by ${shorter} after ${how} at 1000 tall`,620);
      await page.screenshot({path:join(shotsDir,`terminal-room-shrinks-${shell}-${mode}-${name}-1280x${shorter}.png`),animations:"disabled"});
      // The grow key on the drawer's handle at its tallest leaves it so.
      await focusTerminalHandle(page);await page.keyboard.press("ArrowUp");
      await agree(`after ArrowUp on the drawer's handle at 1280 by ${shorter}, ${how} at 1000 tall`,620);
    }
  }finally{await harness.close();await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
});
