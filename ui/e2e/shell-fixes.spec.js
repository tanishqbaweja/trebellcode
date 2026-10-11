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
  // A saved setting is kept, as the server keeps it, so a reload reads it back.
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,Object.assign(appSettings,route.request().postDataJSON()||{})):route.fallback());
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
// order (a thread to go before is refused there); and a fresh home already has a Pinned section. thread/list gives one page of the
// newest threads, and thread/search finds threads by name, newest first, with no place in their section.
async function startCodexHarness(threads,sections,{failOrder=[]}={}){
  const order=new Map(sections.map(section=>[section.id,threads.filter(thread=>thread.section?.id===section.id).map(thread=>thread.id)]));
  const fail=message=>({rpcError:{code:-32600,message}});
  return Object.assign(await startHarness(threads,{respond:message=>{
    const params=message.params||{};
    if(message.method==="threadSection/list")return {data:sections,nextCursor:null};
    if(message.method==="thread/list"){
      if(params.sortKey==="section_position"){
        if(params.sectionId==null)return fail("section-position sorting requires a section filter");
        if(failOrder.includes(params.sectionId))return fail("section order unavailable");
        return {data:(order.get(params.sectionId)||[]).map(id=>({...threads.find(thread=>thread.id===id),turns:[]})),nextCursor:null};
      }
      return {data:[...threads].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,Number(params.limit)||100).map(thread=>({...thread,turns:[]})),nextCursor:null};
    }
    if(message.method==="thread/search"){
      const term=String(params.searchTerm||"").toLowerCase();
      return {data:threads.filter(thread=>!thread.archived&&String(thread.name||"").toLowerCase().includes(term)).sort((a,b)=>b.updatedAt-a.updatedAt).map(thread=>({thread:{...thread,turns:[]},snippet:thread.name})),nextCursor:null};
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
  }}),{order});
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

// The header fixture for the narrow-window tests below: every header action there is (the branch, the desktop app's Open-in
// picker, a project action, Review, the terminal and goal toggles), long names, prCount linked pull requests, and Stop while a
// turn runs. The desktop bridge records each Open in window.__opens and fails one while window.__openFails is set.
async function openHeaderFixture(page,{width,height=800,mode="dark",prCount=3,running=true,editors=[{id:"vscode",label:"Visual Studio Code"}]}){
  await page.addInitScript(editors=>{window.__opens=[];window.__openFails=false;Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{openIn:{list:async()=>({editors}),open:async(path,id)=>{window.__opens.push(id);if(window.__openFails)throw new Error("Deliberate open failure: the editor could not be started")}}}})},editors);
  const project={id:"header-project",name:"Billing reconciliation service with a very long project name",path:process.cwd(),environmentId:null,branch:"feature/reconcile-refunds-in-the-ledger-export",scripts:[{id:"dev-server",name:"Start the billing dev server",command:"npm run dev -- --port 4173"}],preferredScriptId:"dev-server"};
  const thread={id:"header-thread",name:"Investigate why the nightly billing reconciliation job double counts refunds in the ledger export",preview:"Refunds",cwd:process.cwd(),model:"fixture-model",status:{type:"idle"},createdAt:now()-60,updatedAt:now(),turns:[{id:"turn-1",status:"completed",items:[{type:"userMessage",id:"user-1",content:[{type:"text",text:"Why are refunds counted twice?"}]},{type:"agentMessage",id:"assistant-1",text:"Looking."}]}]};
  const prs=Array.from({length:prCount},(_,index)=>({url:"https://github.com/acme/billing/pull/"+(12345+index),number:12345+index,title:"Refund fix "+index,state:"open"}));
  const harness=await startHarness([thread]);
  try{
    await page.setViewportSize({width,height});
    await openApp(page,{harness,threads:[thread],meta:{[thread.id]:{projectless:false,environmentId:null,linkedPullRequests:prs}},project,settings:{appearanceMode:mode},layout:{sidebarWidth:258,rightPanelWidth:520,terminalHeight:330}});
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
async function startTurn(page,header){
  await page.getByTestId("composer").fill("Keep going.");await page.getByTestId("send").click();
  await expect(header.getByRole("button",{name:"Stop",exact:true})).toBeVisible();await settle(page);
}
// The order the header's actions fold in (their data-fold), from the end of the row; Stop and the inspector toggle never fold.
const HEADER_FOLD_ORDER=["goal","terminal","review","script","open-in","source"];
// The header's foldable actions and the folded ones, in the order they fold, and the title's width (shown and whole) now and
// with the last folded action given back to the row. The fit folds no more than the title needs, so that width is short of
// the readable 80px.
const headerFold=header=>header.evaluate((node,order)=>{
  const row=node.querySelector(".workspace-header-actions"),title=node.querySelector(".thread-title-button strong");
  const present=order.filter(id=>row.querySelector(`:scope>[data-fold="${id}"]`)),folded=present.filter(id=>row.querySelector(`:scope>[data-fold="${id}"]`).hasAttribute("data-folded"));
  let titleWithOneLess=null;
  if(folded.length){
    const last=[...node.querySelectorAll(`[data-fold="${folded.at(-1)}"]`)],fit=node.dataset.fit;
    for(const control of last)control.removeAttribute("data-folded");
    if(folded.length===1)node.dataset.fit="4";
    titleWithOneLess=title.clientWidth;
    for(const control of last)control.setAttribute("data-folded","");
    node.dataset.fit=fit;
  }
  return {fit:node.dataset.fit,present,folded,title:title.clientWidth,whole:title.scrollWidth,titleWithOneLess};
},HEADER_FOLD_ORDER);
// Which of the row's controls draws the line that parts the labelled actions from the icon toggles.
const headerSeparators=header=>header.locator(".workspace-header-actions>*").evaluateAll(nodes=>nodes.filter(node=>node.offsetParent&&getComputedStyle(node,"::before").content!=="none").map(node=>node.getAttribute("aria-label")||node.className));
const firstShownToggle=header=>header.locator(".workspace-header-actions>.header-control.icon-only").evaluateAll(nodes=>nodes.find(node=>node.offsetParent)?.getAttribute("aria-label")||null);
async function expectFoldedOnlyAsNeeded(header,state){
  expect(state.folded,"folded actions").toEqual(state.present.slice(0,state.folded.length));
  expect(state.title+1,"title width").toBeGreaterThanOrEqual(Math.min(state.whole,80));
  if(state.folded.length)expect(state.titleWithOneLess+1,"title width with one action fewer folded").toBeLessThan(Math.min(state.whole,80));
  for(const id of state.present)await expect(header.locator(`.workspace-header-actions>[data-fold="${id}"]`),id).toBeVisible({visible:!state.folded.includes(id)});
  await expect(header.getByRole("button",{name:"More actions",exact:true})).toBeVisible({visible:state.folded.length>0});
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
    expect(state.fit).toBe("5");expect(state.present).toEqual(HEADER_FOLD_ORDER);
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
    expect(Number(await header.getAttribute("data-fit"))).toBeLessThan(5);
    await expect(more).toBeHidden();await expect(header.locator("[data-folded]")).toHaveCount(0);
    for(const name of ["Review","Stop","Toggle terminal","Thread goal",project.scripts[0].name])await expect(header.getByRole("button",{name,exact:true}),name).toBeVisible();
    await expect(header.locator(".branch-control")).toBeVisible();await expect(header.locator(".workspace-header-actions>.open-in-wrap")).toBeVisible();
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
    // Stop moves at most two of the row's actions into the menu: the room it takes, and the More actions button's.
    const runningShown=await shownActions();
    expect(idleShown.filter(action=>!runningShown.includes(action)).length,`row before: ${idleShown.join(", ")}; while the turn runs: ${runningShown.join(", ")}`).toBeLessThanOrEqual(2);
    const running=await headerFold(header);
    await expectFoldedOnlyAsNeeded(header,running);
    // What was folded stays folded.
    expect(running.folded.slice(0,idle.folded.length)).toEqual(idle.folded);
    expect(await headerSeparators(header)).toEqual([await firstShownToggle(header)]);
    await expect(more).toBeVisible({visible:running.folded.length>0});
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

// A turn that ends while the More actions menu is open gives Stop's room back to the row, so the last action folded returns to
// it and leaves the menu, which stays open with the rest. Keyboard focus on that action's menu item moves to the menu's button
// instead of falling off the page.
test("a turn ending while the More actions menu is open gives one action back to the row and keeps focus in the menu at 1180x800",async({page})=>{
  test.setTimeout(40_000);
  const {harness,thread,header,more,menu}=await openHeaderFixture(page,{width:1180});
  try{
    const running=await headerFold(header);
    expect(running.folded).toEqual(HEADER_FOLD_ORDER);
    await more.click();await expect(menu).toBeVisible();
    const source=menu.getByRole("button",{name:/^Source control/});
    await source.focus();await expect(source).toBeFocused();
    harness.push("turn/completed",{threadId:thread.id,turn:{id:"turn-live",status:"completed",completedAt:now()}});
    await expect(header.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0);await settle(page);
    const ended=await headerFold(header);
    await expectFoldedOnlyAsNeeded(header,ended);
    expect(ended.folded).toEqual(HEADER_FOLD_ORDER.slice(0,-1));
    await expect(menu).toBeVisible();await expect(source).toBeHidden();
    await expect(more).toBeFocused();
    await expect(menu.locator(":scope>button:visible").first()).toHaveText("Start the billing dev server");
    await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);await expect(more).toBeFocused();
  }finally{await harness.close()}
});

// The More actions menu's Open-in picker is the header's own: an editor chosen in either is the one both open, Open closes the
// menu like its other actions, and a failed Open is reported once the menu has closed (the app's action error, as the menu's
// other actions report theirs) instead of over the menu's next items. The row's picker still shows its own failure beside it.
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
    await expect(toast).toHaveText("Could not open in Cursor: Deliberate open failure: the editor could not be started");
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
    await expect(rowPicker.getByRole("alert")).toHaveText("Deliberate open failure: the editor could not be started");
    await page.evaluate(()=>{window.__openFails=false});
    await rowOpen.click();
    await expect(rowPicker.getByRole("alert")).toHaveCount(0);
    await expect.poll(opens).toEqual(["cursor","cursor","cursor","cursor"]);expect(await preferred()).toBe("cursor");
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
    await expect(page.getByText(/Undo failed/)).toHaveCount(0);
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
