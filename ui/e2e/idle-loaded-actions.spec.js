import { test,expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { ContextEngine } from "../../src/context-engine.mjs";
import { createWorktree,removeWorktree } from "../../src/git-service.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";
import { auditDir,startStreamingFixture } from "./native-stream-fixture.js";
import { keepThreadMeta } from "./test-home.js";

// What the person starts in a thread or the composer, beyond drawing them, loads in the scripts App loads at idle right after the
// first paint (B11): a thread's earlier history (Load earlier messages) with the idle parts (idle-parts.js), a send in the
// background or to several models, a queued follow-up's Send now, Edit from here, Compact and a desktop SnapShot attached with the
// turn support (turn-support.js), and a thread a pull request links, opened from the Source panel, with the thread actions
// (thread-actions.js). Each done before its script has come (here with the script's request held from the page's first ask, which
// comes at idle) waits for it and then does what it did before, once; where the script cannot load, each says so in loadFailed's
// words where its own failure is said.

const RELOAD="Part of Trebell could not load. Reload Trebell to get it back.";
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
// A script of the app's, held from its first request until release() (or refused at every request).
async function holdScript(page,name,{refuse=false}={}){
  const held=[],pattern=new RegExp(`/assets/${name}-[^/]*\\.js$`);let asked=0;
  await page.route(pattern,route=>{asked++;if(refuse)return route.abort("failed");held.push(route)});
  return {
    asked:()=>expect.poll(()=>asked,{message:name+" asked for at idle"}).toBeGreaterThan(0),
    held:()=>held.length,
    async release(){for(const route of held.splice(0))await route.continue()},
    async drop(){for(const route of held.splice(0))await route.continue().catch(()=>{})},
  };
}
// The settings the header's light and dark toggle saves stay in the page, so the shared e2e server keeps its own.
async function keepSettings(page){
  const saved={};
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return json(route,saved)});
}
// The window in dark and then in light at 1280x800, each mode switched with the header's toggle, ending where it began.
async function shootModes(page,name,check=async()=>{}){
  await page.setViewportSize({width:1280,height:800});
  const html=page.locator("html"),start=await html.getAttribute("data-mode");
  for(const mode of ["dark","light"]){
    if(await html.getAttribute("data-mode")!==mode){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(html).toHaveAttribute("data-mode",mode)}
    await check();
    await page.screenshot({animations:"disabled",path:`${auditDir}idle-loaded-actions-${name}-${mode}-1280x800.png`});
  }
  if(await html.getAttribute("data-mode")!==start){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(html).toHaveAttribute("data-mode",start)}
}
// The app stays usable: its sidebar and composer are there.
async function appStays(page){await expect(page.locator(".sidebar"),"the sidebar").toBeVisible();await expect(page.getByTestId("composer"),"the composer").toBeVisible()}

// An OpenCode harness with one thread of turnCount short turns, served newest first in item pages of pageSize: the thread opens on its
// newest page, with Load earlier messages above it. requests: what the page asked the harness.
async function itemPagedThread(page,{turnCount=8,pageSize=4}={}){
  const thread={id:"idle-actions-history",name:"Idle actions history",preview:"paging fixture",historyMode:"paginated",cwd:process.cwd(),createdAt:Date.now()/1000-100,updatedAt:Date.now()/1000,turns:[]};
  const newestFirst=Array.from({length:turnCount},(_,index)=>{const turnId="turn-"+String(index+1).padStart(3,"0");return [{turnId,item:{id:"user-"+turnId,type:"userMessage",text:"User history "+(index+1)}},{turnId,item:{id:"agent-"+turnId,type:"agentMessage",text:"Assistant history "+(index+1)}}]}).reverse().flatMap(pair=>pair.reverse());
  const requests=[],http=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"idle-actions-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume")result={thread:{...thread,turns:[]},itemsBackwardsCursor:"latest",turnsBackwardsCursor:null};
      else if(message.method==="thread/items/list"){
        const cursor=message.params?.cursor,start=cursor==="latest"||!cursor?0:Number(String(cursor).replace("older-",""))||0;
        result={data:newestFirst.slice(start,start+pageSize),nextCursor:start+pageSize<newestFirst.length?"older-"+(start+pageSize):null,backwardsCursor:"latest"};
      }
      else if(message.method==="threadSection/list"||message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="modelProvider/capabilities/read")result={namespaceTools:true,webSearch:true,imageGeneration:false};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const port=await freePort();await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  const close=async()=>{for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))};
  try{
    const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"opencode",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"};
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"opencode",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${port}`,cwd:process.cwd(),platform:process.platform,version:"idle-actions-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}}));
    await page.route(/\/api\/models$/,route=>json(route,{models:["opencode/test-model"],metadata:{provider:"opencode",models:[{id:"opencode/test-model",name:"Test model",provider:"opencode"}]}}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/git\/info\?/,route=>json(route,{isGit:false,root:process.cwd(),branch:null,status:[],remotes:[],worktrees:[]}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?route.request().postDataJSON()?.patch||{}:{}));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,{supported:false}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await keepSettings(page);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await page.getByRole("button",{name:/Idle actions history/}).click();
    await expect(page.getByText("Assistant history "+turnCount,{exact:true})).toBeVisible({timeout:10_000});
  }catch(error){await close();throw error}
  const pages=()=>requests.filter(item=>item.method==="thread/items/list").length;
  return {requests,pages,close};
}

test("Load earlier messages pressed before the idle script has come loads the page once it has, once",async({page})=>{
  test.setTimeout(45_000);
  const script=await holdScript(page,"idle-parts");
  const fixture=await itemPagedThread(page);
  try{
    await script.asked();
    const earlier=page.getByRole("button",{name:"Load earlier messages",exact:true}),before=fixture.pages();
    await expect(earlier).toBeVisible();
    // Pressed twice, as a double click does: the page waits for the script, and asks for nothing yet.
    await earlier.click();await earlier.click();
    expect(script.held(),"the script is still on its way").toBeGreaterThan(0);
    await expect(page.getByText("Assistant history 6",{exact:true})).toHaveCount(0);
    expect(fixture.pages(),"no older page asked for before the script has come").toBe(before);
    await script.release();
    // Once it has come, the press loads the page above, once: the two turns before the newest page show.
    await expect(page.getByText("Assistant history 6",{exact:true})).toBeVisible({timeout:10_000});
    await expect(page.getByText("User history 5",{exact:true})).toBeVisible();await expect(page.getByText("Assistant history 4",{exact:true})).toHaveCount(0);
    expect(fixture.pages(),"one older page").toBe(before+1);
    await expect(page.locator(".history-page-error")).toHaveCount(0);
    await shootModes(page,"load-earlier-after-script",()=>expect(page.getByText("Assistant history 6",{exact:true})).toBeVisible());
    await appStays(page);
  }finally{await script.drop();await fixture.close()}
});

test("Load earlier messages whose script cannot load says so under its button, and the conversation stays",async({page})=>{
  test.setTimeout(45_000);
  const script=await holdScript(page,"idle-parts",{refuse:true});
  const fixture=await itemPagedThread(page);
  try{
    await script.asked();
    const earlier=page.getByRole("button",{name:"Load earlier messages",exact:true}),before=fixture.pages();
    await earlier.click();
    const error=page.locator(".history-page-error");
    await expect(error).toHaveText("Could not load earlier messages: "+RELOAD);
    await expect(error).toHaveAttribute("role","alert");
    expect(fixture.pages(),"no older page asked for").toBe(before);
    await expect(page.getByText("Assistant history 8",{exact:true})).toBeVisible();
    await expect(earlier).toBeVisible();
    await shootModes(page,"load-earlier-cannot-load",()=>expect(error).toBeVisible());
    await appStays(page);
  }finally{await fixture.close()}
});

// A Native thread with one finished turn, open: its message has Edit from here, and the composer has Compact.
async function nativeThread(page,options={}){
  await keepSettings(page);
  const fixture=await startStreamingFixture(page,{providerTurn:async request=>({id:"idle-actions-"+Math.random().toString(36).slice(2,8),provider:request.provider,model:request.model,text:(request.metadata?.completionGate||request.responseJsonSchema?.name==="trebell_completion_gate")?JSON.stringify({status:"complete",progress:"improved",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"Done."}):"The summary of the conversation so far.",toolCalls:[],finishReason:"stop",usage:{inputTokens:12,outputTokens:40,totalTokens:52}}),...options});
  const [thread]=fixture.threads,turn=fixture.threadStore.addTurn(thread.id,{inputText:"Rename the session helper"});
  fixture.threadStore.addItem(thread.id,turn.id,{id:"idle-actions-answer",type:"agentMessage",text:"Renamed the session helper."});fixture.threadStore.finishTurn(thread.id,turn.id);
  await page.setViewportSize({width:1280,height:800});
  await fixture.open("Native streaming");
  await expect(page.getByText("Renamed the session helper.",{exact:true})).toBeVisible({timeout:10_000});
  return fixture;
}
const editFromHere=page=>page.locator(".user-row").getByRole("button",{name:"Edit from here",exact:true}).first();
const question=page=>page.locator("dialog.inspector-text-prompt");
const compactButton=page=>page.getByRole("button",{name:"Compact",exact:true});

test("Edit from here pressed before the turn support has loaded asks once it has come",async({page})=>{
  test.setTimeout(60_000);
  const script=await holdScript(page,"turn-support");
  const fixture=await nativeThread(page);
  try{
    await script.asked();
    await editFromHere(page).click();
    expect(script.held(),"the turn support is still on its way").toBeGreaterThan(0);
    await expect(question(page)).toHaveCount(0);
    await script.release();
    // Once it has come, the press asks its question, once, with Cancel focused: Escape leaves the conversation as it was.
    await expect(question(page)).toBeVisible({timeout:10_000});await expect(question(page)).toHaveCount(1);
    await expect(question(page)).toContainText("Edit from this message?");
    await expect(question(page).getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
    // The question is modal: dark with it open, then, Escape and the header toggle, light with it asked again, which now comes at once.
    await page.screenshot({animations:"disabled",path:`${auditDir}idle-loaded-actions-edit-from-here-after-script-dark-1280x800.png`});
    await page.keyboard.press("Escape");await expect(question(page)).toHaveCount(0);
    await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light");
    await editFromHere(page).click();await expect(question(page)).toBeVisible();
    await page.screenshot({animations:"disabled",path:`${auditDir}idle-loaded-actions-edit-from-here-after-script-light-1280x800.png`});
    await page.keyboard.press("Escape");await expect(question(page)).toHaveCount(0);
    await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
    await expect(page.locator(".user-row").filter({hasText:"Rename the session helper"})).toBeVisible();
    await appStays(page);
  }finally{await script.drop();await fixture.close()}
});

test("Compact pressed before the turn support has loaded compacts once it has come",async({page})=>{
  test.setTimeout(60_000);
  const script=await holdScript(page,"turn-support");
  const fixture=await nativeThread(page);
  try{
    await script.asked();
    await expect(compactButton(page)).toBeVisible();
    await compactButton(page).click();
    expect(script.held(),"the turn support is still on its way").toBeGreaterThan(0);
    await expect(page.locator(".tool-event").filter({hasText:/Compacting context|Context compacted/})).toHaveCount(0);
    await script.release();
    // Once it has come, the compaction runs as Compact's always did: its one row ends compacted.
    const row=page.locator(".tool-event").filter({hasText:/Context compacted/});
    await expect(row).toHaveCount(1,{timeout:15_000});
    await expect(page.locator(".tool-event").filter({hasText:"Context compaction failed"})).toHaveCount(0);
    await row.scrollIntoViewIfNeeded();
    await shootModes(page,"compact-after-script",()=>expect(row).toBeVisible());
    await appStays(page);
  }finally{await script.drop();await fixture.close()}
});

test("Edit from here and Compact say so when the turn support cannot load, and the conversation stays",async({page})=>{
  test.setTimeout(60_000);
  const script=await holdScript(page,"turn-support",{refuse:true});
  const fixture=await nativeThread(page);
  try{
    await script.asked();
    await editFromHere(page).click();
    const toast=page.getByTestId("app-action-error");
    await expect(toast).toHaveText("Could not edit from this message: "+RELOAD);
    await expect(question(page)).toHaveCount(0);
    await shootModes(page,"edit-from-here-cannot-load",()=>expect(toast).toBeVisible());
    await compactButton(page).click();
    const failed=page.locator(".tool-event").filter({hasText:"Context compaction failed: "+RELOAD});
    await expect(failed).toHaveCount(1);
    await expect(page.locator(".tool-event").filter({hasText:"Compacting context"})).toHaveCount(0);
    await failed.scrollIntoViewIfNeeded();
    await shootModes(page,"compact-cannot-load",()=>expect(failed).toBeVisible());
    await expect(page.locator(".user-row").filter({hasText:"Rename the session helper"})).toBeVisible();
    await appStays(page);
  }finally{await fixture.close()}
});

// Control+Enter from New task sends in the background: a thread of its own starts and the composer is free for the next task.
test("a background send made before the turn support has loaded starts once it has come",async({page})=>{
  test.setTimeout(60_000);
  const script=await holdScript(page,"turn-support");
  await keepSettings(page);
  const fixture=await startStreamingFixture(page,{providerTurn:async request=>({id:"idle-actions-background",provider:request.provider,model:request.model,text:(request.metadata?.completionGate||request.responseJsonSchema?.name==="trebell_completion_gate")?JSON.stringify({status:"complete",progress:"improved",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"Done."}):"Background work done.",toolCalls:[],finishReason:"stop",usage:{}})});
  try{
    await page.setViewportSize({width:1280,height:800});
    await script.asked();
    const composer=page.getByTestId("composer"),task="Summarize the session helper in the background";
    await composer.click();await page.keyboard.type(task,{delay:5});await page.keyboard.press("Control+Enter");
    expect(script.held(),"the turn support is still on its way").toBeGreaterThan(0);
    // It waits for the turn support with the draft where it was.
    await expect(composer).toHaveValue(task);await expect(page.locator(".thread-row")).toHaveCount(1);
    expect(fixture.threadStore.list("native")).toHaveLength(1);
    await script.release();
    // Once it has come, the task starts in a thread of its own, once, and the composer is empty for the next.
    await expect(page.locator(".thread-row")).toHaveCount(2,{timeout:15_000});
    await expect(composer).toHaveValue("");
    await expect.poll(()=>fixture.threadStore.list("native").length).toBe(2);
    const started=fixture.threadStore.list("native").find(thread=>thread.id!==fixture.threads[0].id);
    expect(fixture.threadStore.get(started.id)?.turns?.[0]?.items?.find(item=>item.type==="userMessage")?.content?.[0]?.text).toBe(task);
    await shootModes(page,"background-send-after-script",()=>expect(page.locator(".thread-row")).toHaveCount(2));
    await appStays(page);
  }finally{await script.drop();await fixture.close()}
});

// A desktop SnapShot waiting as the window opens (window.trebellDesktop.snapshots) goes to the composer with its chip.
async function desktopSnapshots(page){
  await page.addInitScript(()=>{
    const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    window.__snapshotAcks=[];
    window.trebellDesktop={snapshots:{
      pending:async()=>[{id:"snapshot-waiting"}],
      read:async id=>({id,process:"Notepad",title:"notes.txt - Notepad",width:640,height:480,createdAt:1761800000000,dataBase64:png}),
      ack:async id=>{window.__snapshotAcks.push(id);return {ok:true,id}},
      onCaptured:()=>()=>{},
    }};
  });
  const uploads=[];
  await page.route(/\/api\/attachments\/blob$/,route=>{const body=route.request().postDataJSON();uploads.push(body.name);return json(route,{path:"C:/trebell/attachments/"+body.name})});
  await page.route(/\/api\/attachments\/import$/,route=>json(route,{files:(route.request().postDataJSON()?.paths||[]).map(path=>({path}))}));
  return {uploads,acks:()=>page.evaluate(()=>window.__snapshotAcks)};
}

test("a desktop SnapShot waiting as the window opens is attached once the turn support has come",async({page})=>{
  test.setTimeout(60_000);
  const script=await holdScript(page,"turn-support");
  const snaps=await desktopSnapshots(page);
  await keepSettings(page);
  const fixture=await startStreamingFixture(page);
  try{
    await page.setViewportSize({width:1280,height:800});
    await script.asked();
    const chip=page.getByTestId("context-chip").filter({hasText:"SnapShot: Notepad"});
    await expect(page.getByTestId("composer")).toBeVisible();
    expect(script.held(),"the turn support is still on its way").toBeGreaterThan(0);
    await expect(chip).toHaveCount(0);expect(snaps.uploads).toEqual([]);
    await script.release();
    // Once it has come, the SnapShot is uploaded once and shows on the composer, and the window says it has it.
    await expect(chip).toHaveCount(1,{timeout:10_000});
    expect(snaps.uploads).toEqual(["snapshot-Notepad-1761800000000.png"]);
    await expect.poll(()=>snaps.acks()).toEqual(["snapshot-waiting"]);
    await shootModes(page,"snapshot-after-script",()=>expect(chip).toBeVisible());
    await appStays(page);
  }finally{await script.drop();await fixture.close()}
});

test("a background send and a SnapShot say so when the turn support cannot load, and the draft stays",async({page})=>{
  test.setTimeout(60_000);
  const script=await holdScript(page,"turn-support",{refuse:true});
  const snaps=await desktopSnapshots(page);
  await keepSettings(page);
  const fixture=await startStreamingFixture(page);
  try{
    await page.setViewportSize({width:1280,height:800});
    await script.asked();
    // The SnapShot waiting as the window opened is not attached, says why, and stays waiting (not acknowledged).
    const snapshotError=page.locator(".tool-event").filter({hasText:"Could not attach the SnapShot: "+RELOAD});
    await expect(snapshotError).toHaveCount(1,{timeout:10_000});
    expect(snaps.uploads).toEqual([]);expect(await snaps.acks()).toEqual([]);
    await shootModes(page,"snapshot-cannot-load",()=>expect(snapshotError).toBeVisible());
    const composer=page.getByTestId("composer"),task="Summarize the session helper in the background";
    await composer.click();await page.keyboard.type(task,{delay:5});await page.keyboard.press("Control+Enter");
    const alert=page.getByTestId("composer-alert");
    await expect(alert).toHaveText("Not sent: "+RELOAD+" Your draft is kept.");
    await expect(composer).toHaveValue(task);
    await expect(page.locator(".thread-row")).toHaveCount(1);expect(fixture.threadStore.list("native")).toHaveLength(1);
    await shootModes(page,"background-send-cannot-load",()=>expect(alert).toBeVisible());
    await appStays(page);
  }finally{await fixture.close()}
});

// A Codex thread at rest whose follow-up waits in Codex's own queue, left there before the window opened: it shows under the
// composer with Send now, which starts it as the thread's next turn (thread/queue/start). started(): how many Codex was asked to start.
const QUEUED="Queued before the window opened";
async function codexQueuedThread(page){
  const thread={id:"idle-actions-queue",name:"Idle actions queue",preview:"A follow-up left queued",cwd:process.cwd(),createdAt:Date.now()-1000,updatedAt:Date.now(),turns:[]};
  let queue=[{id:"queued-1",input:[{type:"text",text:QUEUED}],clientUserMessageId:"idle-actions-queued-1"}];
  const calls=[],upstream=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set();
  upstream.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  const notify=(ws,method,params)=>ws.readyState===ws.OPEN&&ws.send(JSON.stringify({method,params}));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"idle-actions-queue"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume"||message.method==="thread/read")result={thread};
      else if(["thread/items/list","thread/attachment/list","threadSection/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="skills/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/queue/list")result={data:queue,nextCursor:null};
      else if(message.method==="thread/queue/start"){
        queue=queue.filter(item=>item.id!==message.params.queuedSubmissionId);const turn={id:"turn-queued-"+calls.length,status:"inProgress",items:[]};
        ws.send(JSON.stringify({id:message.id,result:{turn}}));
        setTimeout(()=>{notify(ws,"thread/queue/changed",{threadId:thread.id});notify(ws,"turn/started",{threadId:thread.id,turn})},0);return;
      }
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstream.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamPort}`});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const close=async()=>{relay.close();for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstream.close(resolve))])};
  try{
    const meta={[thread.id]:{projectless:true,environmentId:null}};await keepThreadMeta(page,meta);
    const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"};
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/codex/ws`,cwd:process.cwd(),platform:process.platform,version:"idle-actions-queue",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:meta}));
    await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,{projects:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await keepSettings(page);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=page.locator(".thread-row").filter({hasText:"Idle actions queue"});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    await expect(page.locator(".queued-message")).toHaveCount(1,{timeout:10_000});
  }catch(error){await close();throw error}
  return {started:()=>calls.filter(call=>call.method==="thread/queue/start").length,close};
}
const sendNow=page=>page.locator(".queued-message").getByRole("button",{name:"Send now",exact:true});

test("Send now pressed before the turn support has loaded starts the queued follow-up once it has come",async({page})=>{
  test.setTimeout(60_000);
  const script=await holdScript(page,"turn-support");
  const fixture=await codexQueuedThread(page);
  try{
    await script.asked();
    await sendNow(page).click();
    expect(script.held(),"the turn support is still on its way").toBeGreaterThan(0);
    // It waits for the turn support: the follow-up stays queued, and Codex is asked to start nothing yet.
    await expect(page.locator(".queued-message")).toContainText(QUEUED);
    expect(fixture.started(),"no follow-up started before the turn support has come").toBe(0);
    await script.release();
    // Once it has come, the follow-up starts as the thread's next turn, once: it leaves the queue and shows as the person's message.
    const sent=page.locator(".user-bubble").filter({hasText:QUEUED});
    await expect(sent).toHaveCount(1,{timeout:10_000});await expect(page.locator(".queued-message")).toHaveCount(0);
    expect(fixture.started(),"started once").toBe(1);
    await expect(page.locator("[data-testid=app-action-error]")).toHaveCount(0);
    await shootModes(page,"send-now-after-script",()=>expect(sent).toBeVisible());
    await appStays(page);
  }finally{await script.drop();await fixture.close()}
});

test("Send now whose turn support cannot load says so, by mouse and by keyboard, and the follow-up stays queued",async({page})=>{
  test.setTimeout(60_000);
  const script=await holdScript(page,"turn-support",{refuse:true});
  const fixture=await codexQueuedThread(page);
  try{
    await script.asked();
    await sendNow(page).click();
    const toast=page.getByTestId("app-action-error");
    await expect(toast).toHaveText("Could not send queued follow-up: "+RELOAD);
    await expect(page.locator(".queued-message")).toContainText(QUEUED);expect(fixture.started(),"nothing started").toBe(0);
    await shootModes(page,"send-now-cannot-load",()=>expect(toast).toBeVisible());
    // From the keyboard the same: said again, and the keyboard stays on Send now, whose follow-up is still there.
    await sendNow(page).focus();await page.keyboard.press("Enter");
    await expect(toast).toHaveText("Could not send queued follow-up: "+RELOAD);
    await expect(sendNow(page)).toBeFocused();
    await expect(page.locator(".queued-message")).toHaveCount(1);expect(fixture.started(),"nothing started").toBe(0);
    await appStays(page);
  }finally{await fixture.close()}
});

// Trebell Native in a real Git repository with two models, Model A and Model B: a new task sent with both picked (Shift-click in the
// model picker) goes to each in a worktree of its own, made as the server makes them. providerCalls: the model of each turn the
// provider was asked for (the completion gate answered apart); worktrees: the ones made.
const execFileAsync=promisify(execFile),git=(cwd,args)=>execFileAsync("git",args,{cwd,windowsHide:true,encoding:"utf8"});
async function nativeFanout(page){
  const root=await mkdtemp(join(tmpdir(),"trebell-idle-actions-fanout-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","trebell-test@example.invalid"]);await git(repo,["config","user.name","Trebell Test"]);
  await writeFile(join(repo,"README.md"),"seed\n","utf8");await git(repo,["add","README.md"]);await git(repo,["commit","-m","seed"]);
  const baseBranch=(await git(repo,["branch","--show-current"])).stdout.trim(),models=["model-a","model-b"];
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),providerCalls=[],worktrees=[];
  const nativeProviderTurn=async request=>{
    if(request.metadata?.completionGate||request.responseJsonSchema?.name==="trebell_completion_gate")return {id:"idle-actions-fanout-gate",provider:request.provider,model:request.model,text:JSON.stringify({status:"complete",progress:"improved",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"Done."}),toolCalls:[],finishReason:"stop",usage:{}};
    providerCalls.push(request.model);return {id:"idle-actions-fanout-"+request.model,provider:request.provider,model:request.model,text:`Completed ${request.model}.`,toolCalls:[],finishReason:"stop",usage:{}};
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"idle-actions-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const close=async()=>{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));for(const path of [...worktrees].reverse())await removeWorktree(repo,path,{force:true}).catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})};
  try{
    const project={id:"idle-actions-fanout-project",name:"Idle Actions Fan-out",path:repo,environmentId:null,effectiveSettings:{defaultWorkspaceMode:"current"}},meta={};
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"idle-actions-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:meta}));
    await page.route(/\/api\/models$/,route=>json(route,{models,metadata:{provider:"agentrouter",models:models.map(id=>({id,name:"Model "+id.slice(-1).toUpperCase(),provider:"agentrouter",agent:"Trebell Native"}))}}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.request().method()==="POST"?json(route,{project:{...project,id:"project-"+worktrees.length,path:route.request().postDataJSON().path,environmentId:null}}):json(route,{projects:[project],project}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:true,cwd:repo,root:repo,branch:baseBranch,branches:[baseBranch],status:[],remotes:[],worktrees:[{path:repo,branch:baseBranch}]}));
    await page.route(/\/api\/git\/action$/,async route=>{
      const body=route.request().postDataJSON();if(body.action!=="worktree-create")return route.fulfill({status:400,contentType:"application/json",body:JSON.stringify({error:"unexpected git action "+body.action})});
      await createWorktree(repo,{branch:body.branch,path:body.path,baseBranch:body.baseBranch,submodules:"none"});worktrees.push(body.path);
      return json(route,{ok:true,result:{worktree:body.path,info:{root:body.path,branch:body.branch}}});
    });
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>{
      if(route.request().method()!=="POST")return json(route,meta[new URL(route.request().url()).searchParams.get("threadId")]||{});
      const body=route.request().postDataJSON();meta[body.threadId]={...(meta[body.threadId]||{}),...(body.patch||{})};return json(route,meta[body.threadId]);
    });
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{supported:false}:{checkpoints:[]}));
    await page.route(/\/api\/context\/packet$/,route=>json(route,{id:"idle-actions-fanout-context",skipped:true,budget:{mode:"skip",pressure:"normal",reserveTokens:1024,maxTokens:0,maxFiles:0}}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await keepSettings(page);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await expect(page.locator(".branch-control")).toContainText(baseBranch,{timeout:10_000});
  }catch(error){await close();throw error}
  return {threadStore,providerCalls,worktrees,close};
}
// Model B picked beside Model A by Shift-click, and the picker closed with Escape: the composer the task is sent from.
async function pickBothModels(page){
  const picker=page.getByTestId("model-picker"),menu=page.locator(".model-picker-menu");
  await picker.click();await menu.getByRole("button",{name:/Model B/}).click({modifiers:["Shift"]});await expect(picker).toContainText("2 models");
  await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
  return page.getByTestId("composer");
}

test("a task sent to two models before the turn support has loaded starts on both once it has come",async({page})=>{
  test.setTimeout(90_000);
  const script=await holdScript(page,"turn-support");
  const fixture=await nativeFanout(page),task="Rename the session helper with both models";
  try{
    await script.asked();
    const composer=await pickBothModels(page);
    await composer.click();await page.keyboard.type(task,{delay:5});await page.keyboard.press("Enter");
    expect(script.held(),"the turn support is still on its way").toBeGreaterThan(0);
    // It waits for the turn support: the text has left the composer as a send's does, and no worktree, thread or model run starts yet.
    await expect(composer).toHaveValue("");
    expect(fixture.worktrees,"no worktree made before the turn support has come").toHaveLength(0);
    await expect(page.locator(".thread-row")).toHaveCount(0);expect(fixture.providerCalls).toHaveLength(0);
    await script.release();
    // Once it has come, the task starts once on each model, each in a worktree and a thread of its own.
    await expect(page.locator(".thread-row")).toHaveCount(2,{timeout:30_000});
    await expect.poll(()=>fixture.providerCalls.length,{timeout:15_000}).toBe(2);
    expect(new Set(fixture.providerCalls)).toEqual(new Set(["model-a","model-b"]));expect(fixture.worktrees).toHaveLength(2);
    await expect(page.getByTestId("composer-alert")).toHaveCount(0);await expect(composer).toHaveValue("");
    await shootModes(page,"two-model-send-after-script",()=>expect(page.locator(".thread-row")).toHaveCount(2));
    await appStays(page);
  }finally{await script.drop();await fixture.close()}
});

test("a task sent to two models whose turn support cannot load says so and keeps the draft",async({page})=>{
  test.setTimeout(90_000);
  const script=await holdScript(page,"turn-support",{refuse:true});
  const fixture=await nativeFanout(page),task="Rename the session helper with both models";
  try{
    await script.asked();
    const composer=await pickBothModels(page);
    await composer.click();await page.keyboard.type(task,{delay:5});await page.keyboard.press("Enter");
    const alert=page.getByTestId("composer-alert");
    await expect(alert).toHaveText("Not sent: "+RELOAD+" Your draft is kept.");
    await expect(composer).toHaveValue(task);await expect(page.getByTestId("model-picker")).toContainText("2 models");
    await expect(page.locator(".thread-row")).toHaveCount(0);expect(fixture.worktrees,"no worktree made").toHaveLength(0);expect(fixture.providerCalls).toHaveLength(0);
    await shootModes(page,"two-model-send-cannot-load",()=>expect(alert).toBeVisible());
    await appStays(page);
  }finally{await fixture.close()}
});

// A Codex thread open in a project on a GitHub branch whose pull request #78 links another thread, one the sidebar does not list: the
// Git tab of the right panel shows it under the pull request, and its button opens it (read from Codex, then shown as the open
// thread). reads(): how many times Codex was asked to read it.
const threadRow=(page,name)=>page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});
async function linkedThreadFixture(page){
  const parent={id:"idle-actions-parent",name:"Idle actions parent",preview:"Parent chat",cwd:process.cwd(),createdAt:Date.now()/1000-30,updatedAt:Date.now()/1000,turns:[]};
  const linked={id:"idle-actions-linked",name:"Linked review thread",preview:"Linked from the pull request",cwd:process.cwd(),createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000-60,turns:[]};
  const project={id:"idle-actions-source",name:"Idle Actions Source",path:process.cwd(),environmentId:null,effectiveSettings:{}};
  const pr={number:78,title:"Linked thread fixture",state:"OPEN",headRefName:"feature/linked",baseRefName:"main",provider:"github",url:"https://github.com/example/fixture/pull/78"};
  const calls=[],upstream=createServer(),wss=new WebSocketServer({noServer:true}),sockets=new Set(),byId=id=>id===linked.id?linked:parent;
  upstream.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"idle-actions-linked"};
      else if(message.method==="thread/list")result={data:[parent],nextCursor:null};
      else if(message.method==="thread/resume")result={thread:byId(message.params?.threadId),itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/read")result={thread:byId(message.params?.threadId)};
      else if(["thread/items/list","thread/attachment/list","thread/queue/list","threadSection/list","collaborationMode/list","skills/list"].includes(message.method))result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstream.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamPort}`});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const close=async()=>{relay.close();for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstream.close(resolve))])};
  try{
    const meta={[parent.id]:{projectless:false,environmentId:null}};await keepThreadMeta(page,meta);
    const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",activeProjectId:project.id};
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/codex/ws`,cwd:process.cwd(),platform:process.platform,version:"idle-actions-linked",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[project],threadMeta:meta}));
    await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai"}]}}));
    await page.route(/\/api\/projects$/,route=>json(route,{projects:[project],project}));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,{checkpoints:[]}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
    await page.route(/\/api\/git\/info\?/,route=>json(route,{isGit:true,root:process.cwd(),branch:"feature/linked",branches:["main","feature/linked"],upstream:"origin/feature/linked",status:[],remotes:[{name:"origin",url:"https://github.com/example/fixture.git"}],worktrees:[]}));
    await page.route(/\/api\/source-control\/diagnostics\?/,route=>json(route,{selectedProvider:"github",detectedProvider:"github",git:{version:"git version fixture"},providers:{github:{label:"GitHub",installed:true,authenticated:true}},capabilities:{github:{create:true,comment:true,review:true,merge:true}}}));
    await page.route(/\/api\/source-control\/prs\?/,route=>json(route,{items:[pr],capabilities:{create:true,comment:true,review:true,merge:true}}));
    await page.route(/\/api\/source-control\/pr-detail\?/,route=>json(route,{provider:"github",item:{...pr,body:"Fixture PR",identity:{provider:"github",host:"github.com",repository:"example/fixture",number:78},files:[],comments:[],reviews:[],statusCheckRollup:[]}}));
    await page.route(/\/api\/source-control\/pr-viewed\?/,route=>json(route,{store:"environment",files:[]}));
    await page.route(/\/api\/source-control\/thread-link\?/,route=>json(route,{threads:[{threadId:linked.id,title:linked.name,archived:false}]}));
    await keepSettings(page);
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=threadRow(page,parent.name);await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
  }catch(error){await close();throw error}
  return {parent,linked,reads:()=>calls.filter(call=>call.method==="thread/read"&&call.params?.threadId===linked.id).length,close};
}
// The Git tab of the right panel, opened by mouse, with the pull request's linked thread under it: its button.
async function linkedThreadButton(page,fixture){
  await page.getByTestId("right-panel-toggle").click();
  const panel=page.getByTestId("right-panel");
  await panel.locator(".context-panel-tab-scroll").getByRole("button",{name:"Git",exact:true}).click();
  await panel.getByRole("button",{name:/#78 Linked thread fixture/}).click();
  const button=panel.getByRole("button",{name:fixture.linked.name,exact:true});await expect(button).toBeVisible({timeout:10_000});
  return {panel,button};
}

test("a linked thread opened from the Source panel before the thread actions have loaded opens once they have come",async({page})=>{
  test.setTimeout(60_000);
  const script=await holdScript(page,"thread-actions");
  const fixture=await linkedThreadFixture(page);
  try{
    await script.asked();
    const {panel,button}=await linkedThreadButton(page,fixture);
    await button.click();
    expect(script.held(),"the thread actions are still on their way").toBeGreaterThan(0);
    // It waits for the thread actions: the parent thread stays open, and Codex is asked nothing about the linked thread yet.
    await expect(threadRow(page,fixture.parent.name)).toHaveClass(/active/);
    expect(fixture.reads(),"no read before the thread actions have come").toBe(0);
    await script.release();
    // Once they have come, the linked thread is read and opens, once, in the sidebar's list too.
    const linkedRow=threadRow(page,fixture.linked.name);
    await expect(linkedRow).toHaveClass(/active/,{timeout:10_000});
    expect(fixture.reads(),"read once").toBe(1);
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await shootModes(page,"linked-thread-after-script",()=>expect(linkedRow).toHaveClass(/active/));
    await appStays(page);
  }finally{await script.drop();await fixture.close()}
});

test("a linked thread whose thread actions cannot load says so in the Source panel, and the open thread stays",async({page})=>{
  test.setTimeout(60_000);
  const script=await holdScript(page,"thread-actions",{refuse:true});
  const fixture=await linkedThreadFixture(page);
  try{
    await script.asked();
    const {panel,button}=await linkedThreadButton(page,fixture);
    await button.click();
    const alert=panel.getByRole("alert");
    await expect(alert).toHaveText("Could not open the linked thread: "+RELOAD);
    await expect(threadRow(page,fixture.parent.name)).toHaveClass(/active/);
    await expect(threadRow(page,fixture.linked.name)).toHaveCount(0);expect(fixture.reads(),"no read").toBe(0);
    await expect(button).toBeVisible();
    await shootModes(page,"linked-thread-cannot-load",()=>expect(alert).toBeVisible());
    await appStays(page);
  }finally{await fixture.close()}
});
