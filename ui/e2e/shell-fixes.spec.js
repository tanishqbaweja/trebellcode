import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";

// The conversation's activity rows, the thread sidebar, the workspace header and the app shell at narrow widths, against a
// fake harness socket (as in reasoning-text.spec.js).
const shotsDir=process.env.TREBELL_E2E_SHOTS_DIR||fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(shotsDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The harness end of the agent socket: it lists the threads, starts the turns it is sent, records every request, and pushes
// what the test sends. respond(message) answers a request itself when it returns a result ({rpcError} answers with that error).
async function startHarness(threads,{respond=()=>undefined}={}){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set(),requests=[];
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{sockets.add(ws);ws.on("close",()=>sockets.delete(ws));ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push({method:message.method,params:message.params});let result={};
    const thread=threads.find(item=>item.id===message.params?.threadId)||threads[0],answer=respond(message);
    if(answer!==undefined)result=answer;
    else if(message.method==="initialize")result={userAgent:"shell-fixes-fixture"};
    else if(message.method==="thread/list")result={data:threads.map(item=>({...item,turns:[]})),nextCursor:null};
    else if(message.method==="thread/resume")result=message.params?.excludeTurns?{thread:{...thread,turns:[]}}:{thread};
    else if(message.method==="turn/start")result={turn:{id:"turn-live",status:"inProgress",items:[]}};
    else if(message.method==="thread/goal/get")result={goal:null};
    else if(message.method==="thread/continuity/get")result={continuity:null};
    else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
    else if(/\/list$/.test(message.method))result={data:[],nextCursor:null};
    ws.send(JSON.stringify(result?.rpcError?{id:message.id,error:result.rpcError}:{id:message.id,result}));
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
// order (a thread to go before is refused there); and a fresh home already has a Pinned section.
async function startCodexHarness(threads,sections,{failOrder=[]}={}){
  const order=new Map(sections.map(section=>[section.id,threads.filter(thread=>thread.section?.id===section.id).map(thread=>thread.id)]));
  const fail=message=>({rpcError:{code:-32600,message}});
  return startHarness(threads,{respond:message=>{
    const params=message.params||{};
    if(message.method==="threadSection/list")return {data:sections,nextCursor:null};
    if(message.method==="thread/list"){
      if(params.sortKey==="section_position"){
        if(params.sectionId==null)return fail("section-position sorting requires a section filter");
        if(failOrder.includes(params.sectionId))return fail("section order unavailable");
        return {data:(order.get(params.sectionId)||[]).map(id=>({...threads.find(thread=>thread.id===id),turns:[]})),nextCursor:null};
      }
      return {data:[...threads].sort((a,b)=>b.updatedAt-a.updatedAt).map(thread=>({...thread,turns:[]})),nextCursor:null};
    }
    if(message.method==="thread/section/move"){
      const thread=threads.find(item=>item.id===params.threadId),sectionId=params.sectionId??null,before=params.beforeThreadId??null;
      if(before&&!sectionId)return fail("beforeThreadId requires a non-null sectionId");
      const members=sectionId?(order.get(sectionId)||[]).filter(id=>id!==thread.id):[];
      if(before&&!members.includes(before))return fail(`before thread ${before} is not in section ${sectionId}`);
      for(const [id,ids] of order)order.set(id,ids.filter(item=>item!==thread.id));
      if(sectionId){members.splice(before?members.indexOf(before):members.length,0,thread.id);order.set(sectionId,members)}
      if((thread.section?.id??null)!==sectionId){thread.section=sectionId?sections.find(section=>section.id===sectionId):null;thread.sectionEnteredAt=sectionId?now():null}
      return {};
    }
    return undefined;
  }});
}
const sidebarGroups=page=>page.locator(".thread-sections section").evaluateAll(sections=>sections.map(section=>[section.querySelector("h4").firstChild.textContent,[...section.querySelectorAll(".thread-main")].map(node=>node.title)]));
const threadRow=(page,name)=>page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});
async function openThread(page,name){const row=threadRow(page,name);await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);return row}
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
      expect(shown).toEqual(prCount===1?[fit>=4?"":"#12345"]:fit>=4?[String(prCount)]:fit>=2?["#12345+"+(prCount-1)]:prs.map(pr=>"#"+pr.number));
      await page.screenshot({path:join(shotsDir,`header-linked-prs-${prCount}-${phase}-${mode}-1280x800.png`),animations:"disabled"});
    }
    // Closing the inspector gives every chip its number back.
    await page.getByTestId("right-panel-toggle").click();await settle(page);
    await expect(header).toHaveAttribute("data-fit","0");
    expect(await chips.evaluateAll(nodes=>nodes.map(node=>node.innerText.trim()))).toEqual(prs.map(pr=>"#"+pr.number));
  }finally{await harness.close()}
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
    // Alpha one moves down past Alpha three, the next result: it goes right after it in the list (the end), past the hidden Beta two.
    await (await menu("Alpha one")).getByRole("button",{name:"Move down",exact:true}).click();
    await expect.poll(moveRequests).toEqual([{threadId:"alpha-one",sectionId:null,beforeThreadId:null}]);
    // Alpha three moves up past Alpha one, the result above it, not past the hidden Beta two next to it in the list.
    await (await menu("Alpha three")).getByRole("button",{name:"Move up",exact:true}).click();
    await expect.poll(()=>moveRequests().at(-1)).toEqual({threadId:"alpha-three",sectionId:null,beforeThreadId:"alpha-one"});
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
    // Pinned threads keep their own order: a pinned thread goes first, and moves within Pinned stay there.
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

test("on Codex the sidebar shows each section in Codex's own order, moves within it, keeps a thread of any section, and moves nothing Codex cannot order",async({page})=>{
  test.setTimeout(60_000);
  const sections=[{id:"0198-pinned",name:"Pinned",appearance:null},{id:"0198-snoozed",name:"Snoozed",appearance:null},{id:"0198-settled",name:"Settled",appearance:null},{id:"0199-research",name:"Research",appearance:null}];
  const base={cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-900,turns:[]},section=id=>sections.find(item=>item.id===id);
  // Codex's Pinned order is alpha, beta, gamma: the order they were pinned, not their last updates (gamma is the newest).
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
  try{
    await openApp(page,{harness,threads,meta});
    // The thread in the Research section (made in another Codex client) has a group of its own instead of vanishing.
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Pinned alpha","Pinned beta","Pinned gamma"]],["Active",["Codex active one","Codex active two"]],["Research",["Research notes"]]]);
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
    // Within Pinned, a move is Codex's own: before the thread above, or before the thread after the next one.
    await move("Pinned gamma","Move up");
    await expect.poll(moves).toEqual([{threadId:"pinned-gamma",sectionId:"0198-pinned",beforeThreadId:"pinned-beta"}]);
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Pinned alpha","Pinned gamma","Pinned beta"]],["Active",["Codex active one","Codex active two"]],["Research",["Research notes"]]]);
    await move("Pinned alpha","Move down");
    await expect.poll(()=>moves().at(-1)).toEqual({threadId:"pinned-alpha",sectionId:"0198-pinned",beforeThreadId:"pinned-beta"});
    const reordered=[["Pinned",["Pinned gamma","Pinned alpha","Pinned beta"]],["Active",["Codex active one","Codex active two"]],["Research",["Research notes"]]];
    await expect.poll(()=>sidebarGroups(page)).toEqual(reordered);
    await page.reload();
    await expect.poll(()=>sidebarGroups(page)).toEqual(reordered);
    await page.screenshot({path:join(shotsDir,"sidebar-codex-pinned-moves-1600x980.png"),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
    // A pinned thread goes first in Pinned; its undo sends it back without a thread to go before (Codex refuses one outside a section).
    await move("Codex active two","Pin");
    await expect.poll(()=>moves().at(-1)).toEqual({threadId:"active-two",sectionId:"0198-pinned",beforeThreadId:"pinned-gamma"});
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Codex active two","Pinned gamma","Pinned alpha","Pinned beta"]],["Active",["Codex active one"]],["Research",["Research notes"]]]);
    await page.getByTestId("thread-undo-toast").getByRole("button",{name:"Undo",exact:true}).click();
    await expect.poll(()=>moves().at(-1)).toEqual({threadId:"active-two",sectionId:null,beforeThreadId:null});
    await expect.poll(()=>sidebarGroups(page)).toEqual(reordered);
    await expect(page.getByText(/Undo failed/)).toHaveCount(0);
  }finally{await harness.close()}
});

test("on Codex a section whose order cannot be read still shows its threads, and the sidebar names it",async({page})=>{
  test.setTimeout(45_000);
  const sections=[{id:"0198-pinned",name:"Pinned",appearance:null},{id:"0198-snoozed",name:"Snoozed",appearance:null},{id:"0198-settled",name:"Settled",appearance:null},{id:"0199-research",name:"Research",appearance:null}];
  const base={cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-900,turns:[]},section=id=>sections.find(item=>item.id===id);
  // Codex's Pinned order is alpha, then beta (beta is the newer one); Research's order cannot be read.
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
    await openApp(page,{harness,threads,meta});
    // Research's threads stay listed (newest first, as listed), Pinned keeps Codex's order, and the error says which order is missing.
    await expect.poll(()=>sidebarGroups(page)).toEqual([["Pinned",["Pinned alpha","Pinned beta"]],["Active",["Codex active one"]],["Research",["Research two","Research one"]]]);
    const alert=page.locator(".sidebar-list-error");
    await expect(alert).toContainText("Could not refresh threads");await expect(alert).toContainText(/Could not read the order of Research \(.*section order unavailable.*\)/);
    await page.screenshot({path:join(shotsDir,"sidebar-codex-section-order-failed-1600x980.png"),animations:"disabled",clip:{x:0,y:0,width:520,height:640}});
    // With no order, Research's threads cannot move, and the menu does not claim the list follows recent activity.
    const row=threadRow(page,"Research two");await row.hover();await row.locator(".thread-menu summary").click();
    for(const label of ["Move up","Move down"]){const item=row.getByRole("button",{name:label,exact:true});await expect(item).toBeDisabled();await expect(item).not.toHaveAttribute("title",/./)}
    await row.locator(".thread-menu summary").click();await expect(row.locator(".thread-menu")).not.toHaveAttribute("open","");
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
