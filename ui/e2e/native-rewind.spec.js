import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { ContextEngine } from "../../src/context-engine.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

// A Native thread with one finished turn in a managed worktree (or, with worktree false, in a project folder that is not one, where
// the files never go back), that turn's file checkpoint, and the page open on the thread. restoreError fails the checkpoint restore
// with that message, revertError has the harness refuse the rewind (thread/revert) with that one, and hold, when given, keeps a new
// turn running until it resolves. nativeDialogs notes every browser dialog (and dismisses it): the app asks in its own.
// openWindow(other) opens the same thread in another window of the app, on the same relay. holdNotices ({on,held}) slows the first
// window's link: while on, the relay's notices to it wait in held (each a function that delivers it).
async function rewindFixture(page,{restoreError=null,revertError=null,hold=null,worktree=true,holdNotices=null}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-rewind-")),home=join(root,"home"),repo=join(root,worktree?"managed-worktree":"native-project");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const thread=threadStore.create({
    runtime:"native",cwd:repo,providerSessionId:"native-rewind-session",model:"gpt-5.6",name:"Native managed rewind",preview:"Checkpoint restore fixture",
    providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"supervised",projectless:false,environmentId:null},
  });
  const turn=threadStore.addTurn(thread.id,{inputText:"Rewind this Native work"});threadStore.addItem(thread.id,turn.id,{id:"native-rewind-answer",type:"agentMessage",text:"Native work changed files."});threadStore.finishTurn(thread.id,turn.id);
  const checkpoint={id:"native-checkpoint-1",threadId:thread.id,turnId:turn.id,label:"before Native work"};
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn:async request=>(hold&&await hold,{id:"unused-native-rewind",provider:request.provider,model:request.model,text:"",toolCalls:[],finishReason:"stop",usage:{}}),version:"visual-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project=worktree
    ?{id:"native-managed-project",name:"Native Managed Worktree",path:repo,environmentId:null,effectiveSettings:{},managedWorktree:{root,branch:"trebell/native-rewind",baseBranch:"main",submodules:"none",createdAt:Date.now(),cleanedAt:null}}
    :{id:"native-project",name:"Native Project",path:repo,environmentId:null,effectiveSettings:{}};
  let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  // The light and dark toggle's saved setting stays in the fixture, so the shared e2e server keeps its own.
  const saved={};
  const fixture={thread,threadStore,checkpoint,restoreBody:null,nativeDialogs:[],openWindow,async close(){await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true})}};
  async function openWindow(page,{holdNotices=null}={}){
    await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"visual-fixture",activeEnvironmentId:null,activeEnvironment:null})}));
    await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}})}));
    await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["gpt-5.6"],metadata:{provider:"agentrouter",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"agentrouter",agent:"Trebell Native"}]}})}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(route.request().method()==="POST"?{project}:{projects:[project]})}));
    await page.route(/\/api\/worktree\/ensure$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({isGit:true,branch:"trebell/native-rewind",root})}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST"){const body=route.request().postDataJSON();uiMeta={...uiMeta,...(body?.patch||{})}}await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(uiMeta)})});
    await page.route(/\/api\/checkpoints\/restore$/,async route=>{fixture.restoreBody=route.request().postDataJSON();await route.fulfill(restoreError?{status:500,contentType:"application/json",body:JSON.stringify({error:restoreError})}:{status:200,contentType:"application/json",body:JSON.stringify({restored:true})})});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({checkpoints:[checkpoint]})}));
    await page.route(/\/api\/context\/packet$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({id:"rewind-context",skipped:true,budget:{reserveTokens:1024}})}));
    await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
    await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(saved)})});
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    // How many of the app's questions this window has shown, so asking twice can be told from asking once.
    await page.addInitScript(()=>{window.__questionsShown=0;new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.matches?.("dialog.inspector-text-prompt"))window.__questionsShown++}).observe(document,{childList:true,subtree:true})});
    page.on("dialog",dialog=>{fixture.nativeDialogs.push(dialog.type()+": "+dialog.message());dialog.dismiss().catch(()=>{})});
    if(revertError||holdNotices)await page.routeWebSocket(/\/api\/agent\/ws/,ws=>{
      const server=ws.connectToServer();
      ws.onMessage(message=>{let parsed=null;try{parsed=JSON.parse(String(message))}catch{}if(revertError&&parsed?.method==="thread/revert"){ws.send(JSON.stringify({id:parsed.id,error:{code:-32000,message:revertError}}));return}server.send(message)});
      if(holdNotices)server.onMessage(message=>{let parsed=null;try{parsed=JSON.parse(String(message))}catch{}if(holdNotices.on&&parsed?.method&&parsed.id==null){holdNotices.held.push(()=>ws.send(message));return}ws.send(message)});
    });
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Native managed rewind"]')});await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();
    await expect(page.getByText("Rewind this Native work",{exact:true})).toBeVisible({timeout:10_000});await expect(messageEdit(page)).toBeVisible();
  }
  await openWindow(page,{holdNotices});
  return fixture;
}
// The light and dark toggle in the header, or its row in More actions where the header folded it away.
async function toggleMode(page){
  const mode=await page.locator("html").getAttribute("data-mode"),direct=page.locator("[data-testid=appearance-toggle]:visible").first();
  if(await direct.count())await direct.click();else{await page.getByRole("button",{name:/More actions/}).first().click();await page.getByRole("menuitem",{name:/Switch to (light|dark) mode/}).first().click()}
  await expect(page.locator("html")).not.toHaveAttribute("data-mode",mode||"");
}
// Screenshots at 1280x800 and 900 wide in the mode shown; with both, each mode in turn, switched with the header toggle. before(),
// when given, runs in each mode before its shots (a toggle is an action, so it clears a failure that is shown).
async function shoot(page,name,{both=true,before=null}={}){
  for(let pass=0;pass<(both?2:1);pass++){
    if(pass)await toggleMode(page);
    if(before)await before();
    const mode=await page.locator("html").getAttribute("data-mode");
    for(const [width,height] of [[1280,800],[900,800]]){
      await page.setViewportSize({width,height});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${width}x${height}.png`});
    }
  }
  if(both)await toggleMode(page);
  await page.setViewportSize({width:1280,height:800});
}
// The first user message's Edit from here (the question it asks has a button of the same name).
const messageEdit=page=>page.locator(".user-row").getByRole("button",{name:"Edit from here",exact:true}).first();
const question=page=>page.locator("dialog.inspector-text-prompt");
const questionsShown=page=>page.evaluate(()=>window.__questionsShown);
// Edit from here on the first user message, confirmed in the app's own question.
async function editFromHere(page){
  await messageEdit(page).click();
  await expect(question(page)).toBeVisible();
  await question(page).getByRole("button",{name:"Edit from here",exact:true}).click();await expect(question(page)).toHaveCount(0);
}
const WORKTREE_QUESTION=/^Edit from this message\?\s+The messages after it are removed from this thread, this message comes back to the composer to edit, and the files in this worktree go back to how they were before it\.$/;
const PROJECT_QUESTION=/^Edit from this message\?\s+The messages after it are removed from this thread, and this message comes back to the composer to edit\.$/;

test("Trebell Native can rewind conversation and files in a managed worktree",async({page})=>{
  test.setTimeout(60_000);
  const fixture=await rewindFixture(page);
  try{
    const edit=messageEdit(page),composer=page.getByTestId("composer");
    await page.setViewportSize({width:1280,height:800});const metrics=await page.locator(".workspace-shell").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(metrics.scroll).toBeLessThanOrEqual(metrics.client+1);
    await composer.click();await page.keyboard.type("A draft I am still writing",{delay:8});
    await page.screenshot({animations:"disabled",path:auditDir+"native-managed-rewind-before-1280x800.png",fullPage:true});
    // Edit from here asks once, in the app's own dialog, saying the files go back too: Cancel (focused) or Escape leaves the
    // conversation, the composer and the files as they were.
    const ask=question(page),cancel=ask.getByRole("button",{name:"Cancel",exact:true}),confirm=ask.getByRole("button",{name:"Edit from here",exact:true});
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.getByTestId("appearance-toggle").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await edit.click();
      await expect(ask.locator("p")).toHaveText(WORKTREE_QUESTION);await expect(cancel).toBeFocused();await expect(confirm).toBeVisible();
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+"native-managed-rewind-question-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
      if(mode==="dark")await cancel.click();else await page.keyboard.press("Escape");
      await expect(ask).toHaveCount(0);await expect(edit).toBeFocused();
      await expect(page.locator(".user-row")).toHaveCount(1);await expect(composer).toHaveValue("A draft I am still writing");
      expect({restore:fixture.restoreBody,turns:fixture.threadStore.get(fixture.thread.id).turns.length}).toEqual({restore:null,turns:1});
    }
    // From the keyboard: Enter on Edit from here, Tab from Cancel to Edit from here, Enter.
    await page.keyboard.press("Enter");await expect(cancel).toBeFocused();
    await page.keyboard.press("Tab");await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");await expect(ask).toHaveCount(0);
    await expect(composer).toHaveValue("Rewind this Native work\n\nA draft I am still writing");await expect(page.locator(".user-row")).toHaveCount(0);
    expect(fixture.restoreBody).toEqual({id:fixture.checkpoint.id,threadId:fixture.thread.id});expect(fixture.threadStore.get(fixture.thread.id).turns).toHaveLength(0);
    expect(fixture.nativeDialogs).toEqual([]);
    await page.screenshot({animations:"disabled",path:auditDir+"native-managed-rewind-after-1280x800.png",fullPage:true});
  }finally{await fixture.close()}
});

// Outside a worktree of its own only the conversation goes back, and the question says only that. Nothing changes until it is
// confirmed, and asking twice (a double click, Enter held on the button) asks once and does not answer it.
test("Edit from here in a project asks once first, and Cancel, Escape, a double click or a held Enter change nothing",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await rewindFixture(page,{worktree:false});
  try{
    const edit=messageEdit(page),composer=page.getByTestId("composer"),ask=question(page);
    const cancel=ask.getByRole("button",{name:"Cancel",exact:true}),confirm=ask.getByRole("button",{name:"Edit from here",exact:true});
    await composer.click();await page.keyboard.type("A draft I am still writing",{delay:8});
    const unchanged=async()=>{
      await expect(ask).toHaveCount(0);
      await expect(page.locator(".user-row")).toHaveCount(1);await expect(page.getByText("Native work changed files.",{exact:true})).toBeVisible();
      await expect(composer).toHaveValue("A draft I am still writing");
      expect({restore:fixture.restoreBody,turns:fixture.threadStore.get(fixture.thread.id).turns.length}).toEqual({restore:null,turns:1});
    };
    for(const mode of ["dark","light"]){
      if(mode==="light")await toggleMode(page);
      await edit.click();
      await expect(ask.locator("p")).toHaveText(PROJECT_QUESTION);await expect(cancel).toBeFocused();await expect(confirm).toBeVisible();
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        await page.screenshot({animations:"disabled",path:auditDir+"native-rewind-project-question-"+mode+"-"+width+"x800.png"});
      }
      await page.setViewportSize({width:1280,height:800});
      if(mode==="dark")await cancel.click();else await page.keyboard.press("Escape");
      await unchanged();await expect(edit).toBeFocused();
    }
    // A double click asks once.
    let shown=await questionsShown(page);
    await edit.dblclick();await expect(ask).toHaveCount(1);expect(await questionsShown(page)).toBe(shown+1);
    await page.keyboard.press("Escape");await unchanged();
    // Enter held on the button asks once, and the repeats do not answer the question it opened.
    shown=await questionsShown(page);
    await edit.focus();await page.keyboard.down("Enter");await expect(ask).toHaveCount(1);await expect(cancel).toBeFocused();
    await page.keyboard.down("Enter");await page.keyboard.down("Enter");await page.keyboard.up("Enter");
    await expect(ask).toHaveCount(1);await expect(cancel).toBeFocused();expect(await questionsShown(page)).toBe(shown+1);
    await page.keyboard.press("Escape");await unchanged();
    // Confirmed, the conversation goes back as before, the draft stays below the message, and no files are restored.
    await edit.click();await confirm.click();await expect(ask).toHaveCount(0);
    await expect(page.locator(".user-row")).toHaveCount(0);expect(fixture.threadStore.get(fixture.thread.id).turns).toHaveLength(0);
    await expect(composer).toHaveValue("Rewind this Native work\n\nA draft I am still writing");
    expect({restore:fixture.restoreBody,dialogs:fixture.nativeDialogs}).toEqual({restore:null,dialogs:[]});
    await shoot(page,"native-rewind-project-confirmed");
  }finally{await fixture.close()}
});

// A turn can start while the question is open, here or in another window. Confirming then is refused the way Edit from here is
// while a turn runs: no files go back and the conversation and the draft stay.
test("a turn started while Edit from here asks is refused once confirmed, and no files go back",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  let release=()=>{};const hold=new Promise(resolve=>{release=resolve});
  const fixture=await rewindFixture(page,{hold});
  const other=await page.context().newPage();
  try{
    const composer=page.getByTestId("composer"),ask=question(page),failure=page.getByTestId("app-action-error");
    await composer.click();await page.keyboard.type("A draft I am still writing",{delay:8});
    await messageEdit(page).click();await expect(ask.locator("p")).toHaveText(WORKTREE_QUESTION);
    // Another window of the app sends a message on the same thread while the question is open here.
    await other.setViewportSize({width:1280,height:800});await fixture.openWindow(other);
    await other.getByTestId("composer").click();await other.keyboard.type("Keep working on the files",{delay:8});await other.keyboard.press("Enter");
    await expect.poll(()=>fixture.threadStore.get(fixture.thread.id).turns.length).toBe(2);
    await expect(page.locator(".stop-control")).toBeVisible({timeout:10_000});
    await ask.getByRole("button",{name:"Edit from here",exact:true}).click();await expect(ask).toHaveCount(0);
    await expect(failure).toContainText("Could not edit from this message: Stop the running turn first.");
    expect({dialogs:fixture.nativeDialogs,restore:fixture.restoreBody,turns:fixture.threadStore.get(fixture.thread.id).turns.length}).toEqual({dialogs:[],restore:null,turns:2});
    await expect(composer).toHaveValue("A draft I am still writing");
    await expect(page.locator(".user-row").first()).toContainText("Rewind this Native work");await expect(page.getByText("Native work changed files.",{exact:true})).toBeVisible();
    await shoot(page,"native-rewind-turn-started-while-asking",{before:async()=>{if(!await failure.isVisible())await messageEdit(page).click();await expect(failure).toContainText("Stop the running turn first.")}});
  }finally{release();await other.close().catch(()=>{});await fixture.close()}
});

// The same when this window has not heard of the other window's turn yet (a slow link): the harness is asked before any file goes
// back, so no file is restored under the turn that runs, and the conversation stays as it was.
test("a turn another window started, whose notice has not reached this window yet, gets no files restored under it when Edit from here is confirmed",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  let release=()=>{};const hold=new Promise(resolve=>{release=resolve});
  const holdNotices={on:false,held:[]};
  const fixture=await rewindFixture(page,{hold,holdNotices});
  const other=await page.context().newPage();
  try{
    const ask=question(page),failure=page.getByTestId("app-action-error");
    await messageEdit(page).click();await expect(ask.locator("p")).toHaveText(WORKTREE_QUESTION);
    // From here this window hears nothing more from the relay until the held notices are let through.
    holdNotices.on=true;
    await other.setViewportSize({width:1280,height:800});await fixture.openWindow(other);
    await other.getByTestId("composer").click();await other.keyboard.type("Keep working on the files",{delay:8});await other.keyboard.press("Enter");
    await expect.poll(()=>fixture.threadStore.get(fixture.thread.id).status?.type,{timeout:10_000}).toBe("active");
    await expect(page.locator(".stop-control")).toHaveCount(0);
    await ask.getByRole("button",{name:"Edit from here",exact:true}).click();await expect(ask).toHaveCount(0);
    await expect(failure).toContainText("Could not edit from this message: Stop the running turn first.");
    expect({restore:fixture.restoreBody,turns:fixture.threadStore.get(fixture.thread.id).turns.length}).toEqual({restore:null,turns:2});
    await expect(page.locator(".user-row").first()).toContainText("Rewind this Native work");await expect(page.getByText("Native work changed files.",{exact:true})).toBeVisible();
  }finally{holdNotices.on=false;for(const send of holdNotices.held.splice(0))try{send()}catch{}release();await other.close().catch(()=>{});await fixture.close()}
});

// Files and conversation stay in step: a file restore that fails rewinds nothing, and says so beside the conversation it left as it
// was. A draft already in the composer is kept.
test("a file restore that fails leaves the conversation as it was and says so, and the draft stays",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await rewindFixture(page,{restoreError:"Deliberate checkpoint restore failure"});
  try{
    const composer=page.getByTestId("composer");
    await composer.click();await page.keyboard.type("A draft I am still writing",{delay:8});
    await editFromHere(page);
    await expect(page.getByTestId("app-action-error")).toContainText("Could not restore the files, so the conversation was not changed: Deliberate checkpoint restore failure");
    expect(fixture.restoreBody).toEqual({id:fixture.checkpoint.id,threadId:fixture.thread.id});
    expect(fixture.nativeDialogs).toEqual([]);
    await expect(page.locator(".user-row")).toHaveCount(1);await expect(page.getByText("Native work changed files.",{exact:true})).toBeVisible();
    expect(fixture.threadStore.get(fixture.thread.id).turns).toHaveLength(1);
    await expect(composer).toHaveValue("A draft I am still writing");
    // Each mode's shots show the failure again: the toggle, an action itself, clears the one shown.
    const failure=page.getByTestId("app-action-error");
    await shoot(page,"native-rewind-restore-failed",{before:async()=>{if(!await failure.isVisible()){await editFromHere(page)}await expect(failure).toContainText("so the conversation was not changed")}});
    await expect(page.locator(".user-row")).toHaveCount(1);expect(fixture.threadStore.get(fixture.thread.id).turns).toHaveLength(1);
  }finally{await fixture.close()}
});

// The files go back before the rewind, so a rewind the harness then refuses leaves them at the checkpoint with the conversation as it
// was: the failure says the files were restored, not only that the edit failed.
test("a rewind the harness refuses after the files were restored says the files went back, and the conversation stays",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await rewindFixture(page,{revertError:"Native rewind target turn was not found."});
  try{
    await editFromHere(page);
    const failure=page.getByTestId("app-action-error");
    await expect(failure).toContainText("Restored the files to the checkpoint, but could not edit from this message: Native rewind target turn was not found.");
    expect(fixture.restoreBody).toEqual({id:fixture.checkpoint.id,threadId:fixture.thread.id});
    await expect(page.locator(".user-row")).toHaveCount(1);expect(fixture.threadStore.get(fixture.thread.id).turns).toHaveLength(1);
    await shoot(page,"native-rewind-refused-after-restore",{before:async()=>{if(!await failure.isVisible()){await editFromHere(page)}await expect(failure).toContainText("Restored the files to the checkpoint")}});
  }finally{await fixture.close()}
});

test("Edit from here keeps a draft already in the composer, below the message it brings back",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const fixture=await rewindFixture(page);
  try{
    const composer=page.getByTestId("composer");
    await composer.click();await page.keyboard.type("A draft I am still writing",{delay:8});
    await editFromHere(page);
    await expect(page.locator(".user-row")).toHaveCount(0);expect(fixture.threadStore.get(fixture.thread.id).turns).toHaveLength(0);
    await expect(composer).toHaveValue("Rewind this Native work\n\nA draft I am still writing");
    await shoot(page,"native-rewind-keeps-draft");
  }finally{await fixture.close()}
});

// While a turn runs the harness refuses a rewind, so Edit from here restores no files either: it says so, without asking, and
// changes nothing.
test("Edit from here while a turn runs restores no files and changes nothing",async({page})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  let release=()=>{};const hold=new Promise(resolve=>{release=resolve});
  const fixture=await rewindFixture(page,{hold});
  try{
    await page.getByTestId("composer").click();await page.keyboard.type("Keep working on the files",{delay:8});await page.keyboard.press("Enter");
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toBeVisible({timeout:10_000});
    await expect.poll(()=>fixture.threadStore.get(fixture.thread.id).turns.length).toBe(2);
    await messageEdit(page).click();
    await expect(page.getByTestId("app-action-error")).toBeVisible();
    await expect(question(page)).toHaveCount(0);
    expect({dialogs:fixture.nativeDialogs,restore:fixture.restoreBody,turns:fixture.threadStore.get(fixture.thread.id).turns.length}).toEqual({dialogs:[],restore:null,turns:2});
    await expect(page.getByTestId("app-action-error")).toContainText("Could not edit from this message: Stop the running turn first.");
    await expect(page.locator(".user-row")).toHaveCount(2);
    await shoot(page,"native-rewind-while-running",{before:async()=>{const failure=page.getByTestId("app-action-error");if(!await failure.isVisible())await messageEdit(page).click();await expect(failure).toContainText("Stop the running turn first.")}});
  }finally{release();await fixture.close()}
});
