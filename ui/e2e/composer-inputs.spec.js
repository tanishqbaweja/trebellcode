import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket,WebSocketServer } from "ws";
import { replyItem,routeRelayApp,startRelayHarness } from "./relay-history-harness.js";
import { routeCodexApp,startCodexHarness } from "./codex-history-harness.js";
import { keepThreadMeta } from "./test-home.js";

// What a person puts into the composer besides typed text (files, slash commands, dictation, the welcome suggestions), over a
// Trebell Native thread on the real agent relay. Attachments go to the GUI server as they do in the app.
const auditDir=fileURLToPath(new URL("../../visual-audit/composer-inputs/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

// One thread, "Composer thread", open, unless newTask leaves the window on New task. replies answers the provider's calls in order.
// refuse(message), when given, names an error to answer a request with instead of the relay (a harness refusing it). turns are the
// thread's turns from before the window opened, in place of its one short reply.
async function openComposerApp(page,{newTask=false,replies=[],refuse=null,turns=[{user:"Look at the login page",items:[replyItem("seed-reply-1","The login page renders.")]}]}={}){
  const harness=await startRelayHarness({replies});
  harness.seedThread("Composer thread",turns);
  await routeRelayApp(page,harness);
  if(refuse)await page.routeWebSocket(harness.wsUrl,ws=>{
    const server=ws.connectToServer();
    ws.onMessage(message=>{
      let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
      const refusal=parsed?.id!=null&&parsed.method?refuse(parsed):null;
      if(refusal){ws.send(JSON.stringify({id:parsed.id,error:{code:-32000,message:refusal}}));return}
      server.send(message);
    });
  });
  // The theme button's setting stays in the page, so later specs on the shared server keep theirs.
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Composer thread"]')});
  await expect(row).toBeVisible();
  if(!newTask){
    await row.locator(".thread-main").click();
    await expect(row).toHaveClass(/active/);await expect(page.getByTestId("composer")).not.toHaveAttribute("placeholder","Opening thread…");
  }
  return harness;
}
// The header's theme button, as a person switches between dark and light, and the window at 1280x800 and 900x800 in that mode.
async function switchMode(page,mode){
  const html=page.locator("html");if(await html.getAttribute("data-mode")===mode)return;
  await page.getByTestId("appearance-toggle").first().click();await expect(html).toHaveAttribute("data-mode",mode);
}
async function shootBoth(page,name,check=async()=>{}){
  for(const mode of ["dark","light"]){
    await switchMode(page,mode);
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await check();await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-"+width+"x800.png"})}
    await page.setViewportSize({width:1280,height:800});
  }
  await switchMode(page,"dark");
}
async function chooseFiles(page,files){
  const [chooser]=await Promise.all([page.waitForEvent("filechooser"),page.getByRole("button",{name:"Attach files"}).click()]);
  await chooser.setFiles(files);
}
const chips=page=>page.locator(".attachment-shelf > span");
const frames=page=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
// The text of each message "Composer thread" has, as the relay stores its turns.
const sentTexts=harness=>harness.turns(harness.threads[0]).map(turn=>(turn.items.find(item=>item.type==="userMessage")?.content||[]).map(part=>part.text||"").join(""));
// A key held down as a keyboard repeats it: the press, then five repeats about 33 ms apart. pressed() waits for what the press did
// before the first repeat comes, as the keyboard waits about half a second.
async function holdKey(page,key,pressed=async()=>{}){
  await page.keyboard.down(key);await pressed();
  for(let repeat=0;repeat<5;repeat++){await page.waitForTimeout(33);await page.keyboard.down(key)}
  await page.keyboard.up(key);await frames(page);
}
// A paste as the browser makes it: the paste event, then, when the app leaves the text to the browser, the text put in at the caret.
const pasteText=(page,text)=>page.getByTestId("composer").evaluate((node,text)=>{
  const data=new DataTransfer();data.setData("text/plain",text);
  if(node.dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true})))document.execCommand("insertText",false,text);
},text);

test("a file over the attachment limit is refused at once by its name, and an accepted file shows as uploading until it is in",async({page},testInfo)=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page);
  try{
    const uploads=[];page.on("request",request=>{if(/\/api\/attachments\/blob$/.test(request.url()))uploads.push(request.url())});
    // 51 MB is over the 50 MB the GUI server keeps: the browser knows the size before reading the file, so it is refused at once,
    // without being read or sent.
    const big=testInfo.outputPath("recording.bin");await writeFile(big,Buffer.alloc(51*1024*1024,7));
    const alert=page.getByTestId("app-action-error"),refusal="Could not attach files: recording.bin: Attachment is larger than 50 MB";
    // The theme button clears the message, so each mode picks the file again.
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      await chooseFiles(page,big);
      await expect(alert).toHaveText(refusal,{timeout:2000});
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(alert).toBeInViewport();await page.screenshot({animations:"disabled",path:auditDir+"attachment-over-limit-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
    }
    await switchMode(page,"dark");
    await expect(chips(page)).toHaveCount(0);
    expect(uploads).toEqual([]);
    // A file within the limit shows as uploading while the server has not answered, and as attached once it has. Picked with it,
    // recording.bin is refused at once, not once notes.txt is in.
    let release=()=>{};const held=new Promise(resolve=>{release=resolve});
    await page.route(/\/api\/attachments\/blob$/,async route=>{await held;await route.fallback()});
    const notes=testInfo.outputPath("notes.txt");await writeFile(notes,"Release notes draft\n".repeat(4000));
    await chooseFiles(page,[big,notes]);
    const chip=chips(page).filter({hasText:"notes.txt"});
    await expect(chip).toHaveText(/notes\.txt\s*Uploading…/);
    await expect(chip).toHaveAttribute("aria-busy","true");
    await expect(alert).toHaveText(refusal,{timeout:2000});
    // The refusal shows above the shelf, clear of the chip uploading (in light mode picked again, as the theme button clears it).
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      if(mode==="light"){await chooseFiles(page,big);await expect(alert).toHaveText(refusal,{timeout:2000})}
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});await expect(chip).toBeInViewport();
        const [toast,shelf]=await Promise.all([alert.boundingBox(),chip.boundingBox()]);expect(toast.y+toast.height).toBeLessThanOrEqual(shelf.y);
        await page.screenshot({animations:"disabled",path:auditDir+"attachment-uploading-"+mode+"-"+width+"x800.png"});
      }
      await page.setViewportSize({width:1280,height:800});
    }
    await switchMode(page,"dark");
    // Nothing is sent meanwhile, or the message would go without the file: Send waits, and Enter keeps the draft.
    const composer=page.getByTestId("composer"),send=page.getByTestId("send");
    await composer.click();await page.keyboard.type("Here are the notes",{delay:15});
    await expect(send).toBeDisabled();await expect(send).toHaveAttribute("title","Waiting for attachments to upload");
    await page.keyboard.press("Enter");
    await expect(composer).toHaveValue("Here are the notes");
    await shootBoth(page,"attachment-uploading-send-waits",()=>expect(send).toBeDisabled());
    release();
    await expect(send).toBeEnabled();
    await expect(chip).not.toHaveAttribute("aria-busy","true");
    await expect(chip).toHaveText("notes.txt");
    await expect(chips(page)).toHaveCount(1);
    expect(uploads).toHaveLength(1);
  }finally{await harness.close()}
});

// A drop on the composer as the browser hands it over. A person's drop of a folder from the file manager cannot be made from a test:
// the page's drop items call "assets" a directory, and reading it fails as Chromium's read of a dropped directory fails. Reading
// "locked.txt" fails as a file the system no longer lets the browser read, and "capture.mov" is a 51 MB video.
const UNREADABLE="The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.";
async function unreadableDrops(page){
  await page.addInitScript(unreadable=>{
    const entry=DataTransferItem.prototype.webkitGetAsEntry;
    DataTransferItem.prototype.webkitGetAsEntry=function(){return this.getAsFile()?.name==="assets"?{isDirectory:true,isFile:false,name:"assets"}:entry.call(this)};
    const read=FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL=function(file){
      const failure=file?.name==="assets"?new DOMException("A requested file or directory could not be found at the time an operation was processed.","NotFoundError"):file?.name==="locked.txt"?new DOMException(unreadable,"NotReadableError"):null;
      if(!failure)return read.call(this,file);
      Object.defineProperty(this,"error",{configurable:true,value:failure});setTimeout(()=>this.dispatchEvent(new ProgressEvent("error")),20);
    };
  },UNREADABLE);
}
async function dropOnComposer(page,names){
  await page.getByTestId("composer").evaluate((node,names)=>{
    const video=name=>name==="capture.mov";
    const data=new DataTransfer();for(const name of names)data.items.add(new File(name==="assets"?[]:video(name)?[new Uint8Array(51*1024*1024)]:["Dropped "+name+"\n"],name,{type:name==="assets"?"":video(name)?"video/quicktime":"text/plain"}));
    node.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:data}));
  },names);
}

test("a dropped folder is named as a folder, also beside a file over the limit, and a dropped file the browser cannot read is named with the reason",async({page})=>{
  test.setTimeout(90_000);
  await unreadableDrops(page);
  const harness=await openComposerApp(page);
  try{
    const alert=page.getByTestId("app-action-error");
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      // The folder is left out and said to be one; the file dropped with it is attached.
      await dropOnComposer(page,["assets","notes-"+mode+".txt"]);
      await expect(alert).toHaveText("Could not attach dropped files: Folders cannot be attached");
      await expect(chips(page).filter({hasText:"notes-"+mode+".txt"})).toHaveCount(1);
      await expect(chips(page).filter({hasText:"assets"})).toHaveCount(0);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(alert).toBeInViewport();await page.screenshot({animations:"disabled",path:auditDir+"dropped-folder-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
      await dropOnComposer(page,["locked.txt"]);
      await expect(alert).toHaveText("Could not attach dropped files: locked.txt: "+UNREADABLE);
      await expect(chips(page).filter({hasText:"locked.txt"})).toHaveCount(0);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(alert).toBeInViewport();await page.screenshot({animations:"disabled",path:auditDir+"dropped-unreadable-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
      // Dropped with a file over the limit, the folder is still named, together with the file's refusal.
      await dropOnComposer(page,["assets","capture.mov"]);
      await expect(alert).toHaveText("Could not attach dropped files: Folders cannot be attached; capture.mov: Attachment is larger than 50 MB");
      await expect(chips(page).filter({hasText:"capture.mov"})).toHaveCount(0);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(alert).toBeInViewport();await page.screenshot({animations:"disabled",path:auditDir+"dropped-folder-and-oversize-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
    }
  }finally{await harness.close()}
});

const GOAL_NEEDS_THREAD="A goal belongs to a thread. Send a first message to start one, then set its goal. Your draft is kept.";
test("/goal with an objective sets the thread's goal, and /goal on New task keeps the draft and says a thread comes first",async({page})=>{
  test.setTimeout(90_000);
  // The harness refuses the first goal it is asked to set.
  let refusals=1;
  const harness=await openComposerApp(page,{refuse:message=>message.method==="thread/goal/set"&&refusals-->0?"Goal store is read-only":null});
  try{
    const composer=page.getByTestId("composer"),panel=page.getByTestId("goal-panel");
    await composer.click();
    await page.keyboard.type("/goal Make the login tests pass",{delay:15});
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("composer-alert")).toHaveText("Could not set the goal: Goal store is read-only. Your draft is kept.");
    await expect(composer).toHaveValue("/goal Make the login tests pass");
    await expect(panel).toHaveCount(0);
    await shootBoth(page,"goal-command-refused",()=>expect(page.getByTestId("composer-alert")).toBeInViewport());
    // Sent again, the goal is set and the Goal panel opens on it.
    await composer.click();await page.keyboard.press("Enter");
    await expect(panel.getByLabel("Objective",{exact:true})).toHaveValue("Make the login tests pass");
    await expect(panel.locator(".goal-status")).toHaveText(/active/i);
    await expect(composer).toHaveValue("");
    await shootBoth(page,"goal-command-set",()=>expect(panel.getByLabel("Objective",{exact:true})).toBeInViewport());
    // On New task there is no thread to set a goal on yet.
    await page.getByRole("button",{name:"Close right panel"}).click();await expect(panel).toHaveCount(0);
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"New task",exact:true}).click();
    await expect(page.locator(".thread-row.active")).toHaveCount(0);
    await composer.click();
    await page.keyboard.type("/goal Ship the release",{delay:15});
    await page.keyboard.press("Enter");
    const alert=page.getByTestId("composer-alert");
    await expect(alert).toHaveText(GOAL_NEEDS_THREAD);
    await expect(composer).toHaveValue("/goal Ship the release");
    await expect(page.locator(".thread-row")).toHaveCount(1);
    await shootBoth(page,"goal-command-new-task",()=>expect(alert).toBeInViewport());
    // Editing the draft clears the note.
    await composer.click();await page.keyboard.press("End");await page.keyboard.type("!",{delay:15});
    await expect(alert).toHaveCount(0);
    // So does a welcome suggestion that takes the draft's place.
    await page.keyboard.press("Enter");await expect(alert).toHaveText(GOAL_NEEDS_THREAD);
    await page.getByRole("button",{name:"Fix a bug",exact:true}).click();
    await expect(composer).toHaveValue("Find a useful bug, fix it, and run the relevant tests.");
    await expect(alert).toHaveCount(0);
    await shootBoth(page,"goal-note-gone-after-suggestion",()=>expect(composer).toBeInViewport());
  }finally{await harness.close()}
});

test("/goal pause, resume and clear on a Native thread change its goal, as the Goal panel's buttons do",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page);
  try{
    const composer=page.getByTestId("composer"),panel=page.getByTestId("goal-panel"),objective=panel.getByLabel("Objective",{exact:true}),status=panel.locator(".goal-status");
    const goal=async text=>{await composer.click();await page.keyboard.type(text,{delay:15});await page.keyboard.press("Enter");await expect(composer).toHaveValue("")};
    await goal("/goal Make the login tests pass");
    await expect(objective).toHaveValue("Make the login tests pass");await expect(status).toHaveText("active");
    // The words are commands, never the objective.
    await goal("/goal pause");
    await expect(status).toHaveText("paused");await expect(objective).toHaveValue("Make the login tests pass");
    await shootBoth(page,"goal-command-paused",()=>expect(status).toBeInViewport());
    await goal("/goal resume");
    await expect(status).toHaveText("active");await expect(objective).toHaveValue("Make the login tests pass");
    await goal("/goal clear");
    await expect(status).toHaveText("not set");await expect(objective).toHaveValue("");
    await shootBoth(page,"goal-command-cleared",()=>expect(status).toBeInViewport());
  }finally{await harness.close()}
});

test("the Goal panel's Clear asks in the app's own dialog, never the browser's: Escape keeps the goal, and Clear goal clears it from the keyboard",async({page})=>{
  test.setTimeout(90_000);
  const nativeDialogs=[];page.on("dialog",dialog=>{nativeDialogs.push(dialog.type()+": "+dialog.message());dialog.dismiss().catch(()=>{})});
  const harness=await openComposerApp(page);
  try{
    const composer=page.getByTestId("composer"),panel=page.getByTestId("goal-panel"),objective=panel.getByLabel("Objective",{exact:true}),status=panel.locator(".goal-status");
    await composer.click();await page.keyboard.type("/goal Make the login tests pass",{delay:15});await page.keyboard.press("Enter");
    await expect(objective).toHaveValue("Make the login tests pass");await expect(status).toHaveText("active");
    const clear=panel.getByRole("button",{name:"Clear",exact:true}),question=page.locator("dialog.inspector-text-prompt"),cancel=question.getByRole("button",{name:"Cancel",exact:true});
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      await clear.click();
      await expect(question.locator("p")).toHaveText("Clear this thread goal?");await expect(cancel).toBeFocused();
      await expect(question.getByRole("button")).toHaveText(["Cancel","Clear goal"]);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+"goal-clear-question-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
      await page.keyboard.press("Escape");await expect(question).toHaveCount(0);await expect(clear).toBeFocused();
      await expect(status).toHaveText("active");await expect(objective).toHaveValue("Make the login tests pass");
    }
    // From the keyboard: Enter on Clear, Tab from Cancel to Clear goal, Enter.
    await page.keyboard.press("Enter");await expect(cancel).toBeFocused();
    await page.keyboard.press("Tab");await expect(question.getByRole("button",{name:"Clear goal",exact:true})).toBeFocused();await page.keyboard.press("Enter");
    await expect(status).toHaveText("not set");await expect(objective).toHaveValue("");
    expect(nativeDialogs).toEqual([]);
  }finally{await harness.close()}
});

// A Codex app-server without goals (one from before them) answers every thread/goal/* request with Method not found.
test("on a Codex without goals, /goal keeps the objective in the composer and says this Codex does not support goals, never Codex's Method not found",async({page})=>{
  test.setTimeout(90_000);
  const thread={id:"codex-without-goals",name:"Codex without goals",preview:"Codex without goals",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const harness=await startCodexHarness(thread,[]),goalRequests=[];
  try{
    await routeCodexApp(page,harness,thread);
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
    await page.routeWebSocket(harness.wsUrl,ws=>{
      const server=ws.connectToServer();
      ws.onMessage(message=>{
        let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
        if(parsed?.id!=null&&/^thread\/goal\//.test(parsed.method||"")){goalRequests.push(parsed.method);ws.send(JSON.stringify({id:parsed.id,error:{code:-32601,message:"Method not found: "+parsed.method}}));return}
        server.send(message);
      });
    });
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Codex without goals"]')});
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    const composer=page.getByTestId("composer"),alert=page.getByTestId("composer-alert"),said="Could not set the goal: this Codex does not support goals. Your draft is kept.";
    await expect(composer).not.toHaveAttribute("placeholder","Opening thread…");
    await expect.poll(()=>goalRequests).toContain("thread/goal/get");
    // The thread has no goal to load, which is no error.
    await expect.soft(page.getByText(/Method not found/),"the opened thread shows no Method not found").toHaveCount(0);
    // The person sets a goal with Enter: Codex refuses it, and the objective stays in the composer with the reason beside it.
    await composer.click();await page.keyboard.type("/goal Ship the release",{delay:15});await page.keyboard.press("Enter");
    await expect(alert).toHaveText(said);
    await expect(composer).toHaveValue("/goal Ship the release");
    // Then with the Send button: the same.
    await page.getByTestId("send").click();
    await expect.poll(()=>goalRequests.filter(method=>method==="thread/goal/set").length).toBe(2);
    await expect(alert).toHaveText(said);await expect(composer).toHaveValue("/goal Ship the release");
    await shootBoth(page,"goal-command-codex-without-goals",()=>expect(alert).toBeInViewport());
    // A goal word is refused the same way, by what it was to do.
    await composer.click();await page.keyboard.press("Control+A");await page.keyboard.type("/goal pause",{delay:15});await page.keyboard.press("Enter");
    await expect(alert).toHaveText("Could not pause the goal: this Codex does not support goals. Your draft is kept.");await expect(composer).toHaveValue("/goal pause");
    // The Goal panel's Set goal says it too.
    await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    const panel=page.getByTestId("goal-panel");
    await panel.getByLabel("Objective",{exact:true}).fill("Ship the release");await panel.getByRole("button",{name:"Set goal",exact:true}).click();
    await expect(panel.locator(".inline-error")).toHaveText("Could not set the goal: this Codex does not support goals.");
    await shootBoth(page,"goal-panel-codex-without-goals",()=>expect(panel.locator(".inline-error")).toBeInViewport());
    // No turn went to Codex, and no Method not found reached the window: not on opening the thread, not for /goal.
    expect(harness.calls.filter(call=>call.method==="turn/start")).toEqual([]);
    await expect(page.getByText(/Method not found/)).toHaveCount(0);
  }finally{await harness.close()}
});

// /goal on a Codex with goals sets the goal, paused until its first turn has started, then starts that turn. When the turn does not
// start, the note says what became of the goal: a Stop before it started keeps the draft with no note, as a send does; a turn Codex
// refuses leaves the goal set, and says why the turn did not start; a turn Codex has not answered may still start, so the note says to
// look at the conversation first. Each said "Could not set the goal", though the goal was set. A resume whose turn Codex refuses
// leaves the goal paused, so it still says the resume did not go through.
test("/goal whose first turn does not start says what became of the goal: nothing on a Stop, set on a refusal, may still start unanswered",async({page})=>{
  test.setTimeout(120_000);
  const thread={id:"codex-goal-turns",name:"Codex goal turns",preview:"Codex goal turns",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const harness=await startCodexHarness(thread,[]),goalSets=[],turnStarts=[];
  // hold-goal: thread/goal/set waits for releaseGoal(); refuse-turn: Codex refuses turn/start; silent-turn: turn/start is never answered.
  // The goal last set is the one thread/goal/get gives.
  let mode="hold-goal",releaseGoal=()=>{},lastGoal=null;
  try{
    await routeCodexApp(page,harness,thread);
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
    await page.routeWebSocket(harness.wsUrl,ws=>{
      const server=ws.connectToServer();
      ws.onMessage(message=>{
        let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
        if(parsed?.id!=null&&parsed.method==="thread/goal/set"){
          goalSets.push(parsed.params);
          const at=Math.floor(Date.now()/1000),goal={threadId:thread.id,objective:parsed.params.objective||lastGoal?.objective||"Ship the release",status:parsed.params.status||"active",tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:at,updatedAt:at};
          const answer=()=>{lastGoal=goal;ws.send(JSON.stringify({id:parsed.id,result:{goal}}))};
          if(mode==="hold-goal"){releaseGoal=answer;return}
          answer();return;
        }
        if(parsed?.id!=null&&parsed.method==="thread/goal/get"&&lastGoal){ws.send(JSON.stringify({id:parsed.id,result:{goal:lastGoal}}));return}
        if(parsed?.id!=null&&parsed.method==="turn/start"){
          turnStarts.push(parsed.params);
          if(mode==="refuse-turn"){ws.send(JSON.stringify({id:parsed.id,error:{code:-32000,message:"The model is overloaded"}}));return}
          if(mode==="silent-turn")return;
        }
        server.send(message);
      });
    });
    await page.clock.install();
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Codex goal turns"]')});
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    const composer=page.getByTestId("composer"),alert=page.getByTestId("composer-alert"),stop=page.getByRole("button",{name:"Stop",exact:true}),draft="/goal Ship the release";
    await expect(composer).not.toHaveAttribute("placeholder","Opening thread…");
    // Stop while Codex sets the goal: the goal is set (paused), no turn starts, and the draft stays with no note.
    await composer.click();await page.keyboard.type(draft,{delay:15});await page.keyboard.press("Enter");
    await expect.poll(()=>goalSets.length).toBe(1);await expect(stop).toBeVisible();await stop.click();
    releaseGoal();
    await expect(stop).toHaveCount(0,{timeout:10_000});await expect(composer).toHaveValue(draft);
    await page.waitForTimeout(500);
    // Soft, so that the old build also shows what the other two say.
    await expect.soft(alert,"a Stop says nothing went wrong").toHaveCount(0);
    expect(turnStarts,"no turn started after the Stop").toEqual([]);
    // Codex refuses the goal's first turn: the goal is set, and the note says why its turn did not start.
    mode="refuse-turn";await composer.click();await page.keyboard.press("End");await page.keyboard.press("Enter");
    await expect.poll(()=>turnStarts.length).toBe(1);
    await expect.soft(alert,"a refused first turn").toHaveText("The goal is set, but its first turn did not start: The model is overloaded. Your draft is kept.");
    await expect(composer).toHaveValue(draft);
    await shootBoth(page,"goal-command-turn-refused",()=>expect(alert).toBeInViewport());
    // Codex does not answer the goal's first turn: it may still start, so the note says to look at the conversation before sending again.
    mode="silent-turn";await composer.click();await page.keyboard.press("End");await page.keyboard.press("Enter");
    await expect.poll(()=>turnStarts.length).toBe(2);
    await page.clock.fastForward("10:01");
    await expect.soft(alert,"an unanswered first turn").toHaveText("Codex has not answered the send, so it may still start. Your draft is kept; check the conversation before sending it again.");
    await expect(composer).toHaveValue(draft);
    // /goal resume whose turn Codex refuses: the goal stays paused, so the resume did not go through.
    mode="refuse-turn";await composer.click();await page.keyboard.press("Control+A");await page.keyboard.type("/goal resume",{delay:15});await page.keyboard.press("Enter");
    await expect.poll(()=>turnStarts.length).toBe(3);
    await expect(alert,"a resume whose turn Codex refused").toHaveText("Could not resume the goal: The model is overloaded. Your draft is kept.");await expect(composer).toHaveValue("/goal resume");
    expect(goalSets.map(params=>params.status),"each /goal set the goal paused until its turn starts").toEqual(["paused","paused","paused","paused"]);
  }finally{await harness.close()}
});

// A person's double click on a button: two clicks at one spot, the second counted as a double click's. The relay answers the first
// at once, so the button that comes up in its place (next) is under the pointer and ready when the second click comes.
async function doubleClickAs(page,button,next){
  const box=await button.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.mouse.down();await page.mouse.up();
  await expect(next).toBeEnabled();
  await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});
}

test("a double click on the Goal panel's Pause pauses the goal once and one on Resume resumes it once: the second click does nothing on the button that took its place",async({page})=>{
  test.setTimeout(90_000);
  const statuses=[];page.on("websocket",socket=>socket.on("framesent",frame=>{try{const message=JSON.parse(String(frame.payload));if(message?.method==="thread/goal/set")statuses.push(message.params?.status)}catch{}}));
  const harness=await openComposerApp(page);
  try{
    await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    const panel=page.getByTestId("goal-panel"),status=panel.locator(".goal-status"),button=name=>panel.getByRole("button",{name,exact:true});
    await panel.getByLabel("Objective",{exact:true}).click();await page.keyboard.type("Make the login tests pass",{delay:15});
    await button("Set goal").click();await expect(status).toHaveText("active");
    // Resume comes up where Pause was as the first click's save answers; the second click leaves it there, ready, and the goal paused.
    await doubleClickAs(page,button("Pause"),button("Resume"));
    await expect(button("Resume")).toBeEnabled();await expect(status).toHaveText("paused");
    expect(statuses).toEqual(["active","paused"]);
    await shootBoth(page,"goal-pause-double-click",()=>expect(button("Resume")).toBeInViewport());
    // The same for Resume, which Pause replaces.
    await doubleClickAs(page,button("Resume"),button("Pause"));
    await expect(button("Pause")).toBeEnabled();await expect(status).toHaveText("active");
    expect(statuses).toEqual(["active","paused","active"]);
    // A click of its own pauses the goal as before.
    await button("Pause").click();await expect(status).toHaveText("paused");
    expect(statuses).toEqual(["active","paused","active","paused"]);
  }finally{await harness.close()}
});

// The page's socket to the relay, passed through here; set it up before the app opens. hold(method) keeps that method's requests
// until release() sends them on (a slow harness); drop() closes the socket and keeps the window from connecting again until back()
// (a harness that goes away and comes back); answer(method,change) changes what the relay answers to that method from then on.
async function relaySocket(page){
  const sent=[],sockets=[],held=[],answers=new Map();let holding=null,away=false;
  await page.routeWebSocket(/\/api\/agent\/ws$/,ws=>{
    if(away){ws.close({code:1011,reason:"harness down"}).catch(()=>{});return}
    const server=ws.connectToServer(),asked=new Map();sockets.push({ws,server});
    ws.onMessage(message=>{
      let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
      if(parsed?.method){sent.push(parsed);if(parsed.id!=null)asked.set(parsed.id,parsed.method)}
      if(parsed?.method&&parsed.method===holding)held.push(()=>server.send(message));else server.send(message);
    });
    server.onMessage(message=>{
      let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
      const change=parsed?.result&&answers.get(asked.get(parsed.id));
      ws.send(change?JSON.stringify({...parsed,result:change(parsed.result)}):message);
    });
  });
  return {
    sent:method=>sent.filter(message=>message.method===method).map(message=>message.params||{}),
    hold(method){holding=method},release(){holding=null;for(const send of held.splice(0))send()},
    answer(method,change){answers.set(method,change)},
    drop(){away=true;for(const {ws,server} of sockets.splice(0)){ws.close({code:1011,reason:"harness down"}).catch(()=>{});server.close().catch(()=>{})}},
    back(){away=false},
  };
}
// Two frames on: the page has drawn what it was last given, and has done what React does once it is drawn (its effects).
const painted=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve)))));
async function typeOver(page,field,text){await field.click();await page.keyboard.press("Control+A");await page.keyboard.type(text,{delay:15})}
// The Goal panel opened from the header, with a goal set there that keeps a completion condition: every read of the goal, and
// every save's answer, brings its lists anew.
async function setGoalInPanel(page){
  await page.getByRole("button",{name:"Thread goal",exact:true}).click();
  const panel=page.getByTestId("goal-panel"),objective=panel.getByLabel("Objective",{exact:true});
  await objective.click();await page.keyboard.type("Make the login tests pass",{delay:15});
  await panel.getByText("Completion & guardrails",{exact:true}).click();
  await panel.getByLabel("Completion conditions",{exact:true}).click();await page.keyboard.type("Login tests pass",{delay:15});
  await panel.getByRole("button",{name:"Set goal",exact:true}).click();await expect(panel.locator(".goal-status")).toHaveText("active");
  return {panel,objective};
}

test("an unsaved Goal edit and note are still there after a look at Files and after the right panel is closed and opened again, until Update goal saves the edit",async({page})=>{
  test.setTimeout(90_000);
  const socket=await relaySocket(page);
  const harness=await openComposerApp(page);
  try{
    const {panel,objective}=await setGoalInPanel(page);
    const conditions=panel.getByLabel("Completion conditions",{exact:true}),done=panel.getByLabel("Completed work",{exact:true}),tabs=page.getByTestId("right-panel").locator(".context-panel-tab-scroll");
    await typeOver(page,objective,"Make the login and signup tests pass");
    await panel.getByText("Continuity state",{exact:true}).click();await done.click();await page.keyboard.type("Fixed the session refresh",{delay:15});
    // A look at Files takes the panel away, and Goal brings it back as it was left.
    await tabs.getByRole("button",{name:"Files",exact:true}).click();await expect(panel).toHaveCount(0);
    await tabs.getByRole("button",{name:"Goal",exact:true}).click();
    await expect(objective).toHaveValue("Make the login and signup tests pass");await expect(conditions).toHaveValue("Login tests pass");
    await panel.getByText("Continuity state",{exact:true}).click();await expect(done).toHaveValue("Fixed the session refresh");
    // So does the right panel closed and opened again from the header.
    await page.getByRole("button",{name:"Close right panel"}).click();await expect(panel).toHaveCount(0);
    await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    await expect(objective).toHaveValue("Make the login and signup tests pass");
    await shootBoth(page,"goal-draft-after-files",()=>objective.scrollIntoViewIfNeeded());
    // Update goal saves the edit, which the panel then shows as the goal.
    await panel.getByRole("button",{name:"Update goal",exact:true}).click();
    await expect.poll(()=>socket.sent("thread/goal/set").map(params=>params.objective)).toEqual(["Make the login tests pass","Make the login and signup tests pass"]);
    await expect(panel.getByRole("button",{name:"Update goal",exact:true})).toBeEnabled();await expect(objective).toHaveValue("Make the login and signup tests pass");
  }finally{await harness.close()}
});

test("an unsaved Goal edit and note are still there when the harness drops and comes back and the thread's goal is read again",async({page})=>{
  test.setTimeout(90_000);
  const socket=await relaySocket(page);
  const harness=await openComposerApp(page);
  try{
    const {panel,objective}=await setGoalInPanel(page);
    const done=panel.getByLabel("Completed work",{exact:true});
    await typeOver(page,objective,"Make the login and signup tests pass");
    await panel.getByText("Continuity state",{exact:true}).click();await done.click();await page.keyboard.type("Fixed the session refresh",{delay:15});
    socket.drop();
    await expect(page.getByTestId("right-panel")).toContainText("Agent harness is reconnecting");
    // The window connects again and opens the thread again, which reads its goal: here with the tokens its turns used meanwhile,
    // which the metrics show once that read is in.
    socket.answer("thread/goal/get",result=>({...result,goal:{...result.goal,tokensUsed:1234}}));
    socket.back();
    await expect(panel.locator(".goal-metrics")).toContainText("1,234",{timeout:20_000});
    await painted(page);
    await expect(objective).toHaveValue("Make the login and signup tests pass");
    await expect(panel.getByLabel("Completion conditions",{exact:true})).toHaveValue("Login tests pass");
    await expect(done).toHaveValue("Fixed the session refresh");
    await shootBoth(page,"goal-draft-after-reconnect",()=>objective.scrollIntoViewIfNeeded());
  }finally{await harness.close()}
});

test("words typed on into the Objective while a slow save is on its way are still there when it lands, and Update goal then saves them",async({page})=>{
  test.setTimeout(90_000);
  const socket=await relaySocket(page);
  const harness=await openComposerApp(page);
  try{
    const {panel,objective}=await setGoalInPanel(page);
    const update=panel.getByRole("button",{name:"Update goal",exact:true}),objectives=()=>socket.sent("thread/goal/set").map(params=>params.objective);
    await typeOver(page,objective,"Make the signup tests pass");
    // The harness takes its time over the save, and the person goes on typing meanwhile.
    socket.hold("thread/goal/set");
    await update.click();await expect(update).toBeDisabled();
    await objective.click();await page.keyboard.press("End");await page.keyboard.type(" on Firefox",{delay:15});
    socket.release();
    await expect(update).toBeEnabled();await painted(page);
    await expect(objective).toHaveValue("Make the signup tests pass on Firefox");
    await expect(panel.locator(".goal-field-changed"),"the goal this panel saved is not a change made elsewhere").toHaveCount(0);
    expect(objectives()).toEqual(["Make the login tests pass","Make the signup tests pass"]);
    await shootBoth(page,"goal-typed-on-during-save",()=>objective.scrollIntoViewIfNeeded());
    await update.click();
    await expect.poll(objectives).toEqual(["Make the login tests pass","Make the signup tests pass","Make the signup tests pass on Firefox"]);
    await expect(update).toBeEnabled();await expect(objective).toHaveValue("Make the signup tests pass on Firefox");
  }finally{await harness.close()}
});

// A change made elsewhere to a goal field edited here (the /goal command, here while the panel was closed and while it is open) is
// said above Update goal, with Use saved and Keep mine, and Discard changes takes every edit back. The edit stayed with nothing to
// say the saved goal had changed and no way to drop it, so an Update goal pressed only for a budget wrote it over the new objective.
test("a goal changed elsewhere while its Objective is edited here says so above Update goal, Use saved and Keep mine choose, and Discard changes takes the edits back",async({page})=>{
  test.setTimeout(120_000);
  const socket=await relaySocket(page);
  const harness=await openComposerApp(page);
  try{
    const {panel,objective}=await setGoalInPanel(page);
    const composer=page.getByTestId("composer"),changed=panel.locator(":scope>.goal-actions").getByRole("status"),button=name=>panel.getByRole("button",{name,exact:true});
    const tokens=panel.getByLabel("Token budget",{exact:true}),lastSave=()=>socket.sent("thread/goal/set").at(-1),question=page.locator("dialog.inspector-text-prompt");
    const goalCommand=async text=>{await composer.click();await page.keyboard.type(text,{delay:15});await page.keyboard.press("Enter");await expect(composer).toHaveValue("")};
    await typeOver(page,objective,"Make the login and signup tests pass");
    await expect.soft(button("Discard changes"),"an edit offers Discard changes by Update goal").toBeVisible();
    // The panel is closed, and the goal set again from the composer, which opens the panel on it.
    await page.getByRole("button",{name:"Close right panel"}).click();await expect(panel).toHaveCount(0);
    await goalCommand("/goal Make the checkout tests pass");
    await expect(objective).toHaveValue("Make the login and signup tests pass");
    await expect(changed,"the objective set elsewhere is said above Update goal").toContainText("Objective changed elsewhere to “Make the checkout tests pass” while you were editing.");
    await shootBoth(page,"goal-changed-elsewhere",()=>expect(changed).toBeInViewport());
    // Use saved takes the objective set elsewhere, and a budget typed then is saved with it.
    await changed.getByRole("button",{name:"Use saved",exact:true}).click();
    await expect(objective).toHaveValue("Make the checkout tests pass");await expect(changed).toHaveCount(0);
    await typeOver(page,tokens,"5000");await button("Update goal").click();
    await expect.poll(lastSave).toMatchObject({objective:"Make the checkout tests pass",tokenBudget:5000});
    await expect(button("Update goal")).toBeEnabled();await expect(button("Discard changes")).toHaveCount(0);
    // Set elsewhere again while the objective is edited with the panel open: Keep mine keeps the edit, and Update goal saves it.
    await typeOver(page,objective,"Make the checkout and refund tests pass");
    await goalCommand("/goal Make the payment tests pass");
    await expect(changed).toContainText("Objective changed elsewhere to “Make the payment tests pass” while you were editing.");
    await expect(objective).toHaveValue("Make the checkout and refund tests pass");
    await changed.getByRole("button",{name:"Keep mine",exact:true}).click();await expect(changed).toHaveCount(0);
    await button("Update goal").click();
    await expect.poll(lastSave).toMatchObject({objective:"Make the checkout and refund tests pass",tokenBudget:5000});
    await expect(button("Update goal")).toBeEnabled();await expect(button("Discard changes")).toHaveCount(0);
    // Discard changes, once asked, takes back every edit made since.
    await typeOver(page,objective,"Make every test pass");await typeOver(page,tokens,"7000");
    await button("Discard changes").click();
    await expect(question.locator("p")).toHaveText("Discard your changes to this goal?");
    await question.getByRole("button",{name:"Discard changes",exact:true}).click();await expect(question).toHaveCount(0);
    await expect(objective).toHaveValue("Make the checkout and refund tests pass");await expect(tokens).toHaveValue("5000");
    await expect(button("Discard changes")).toHaveCount(0);
  }finally{await harness.close()}
});

// Another window's request to the relay, whose notifications reach the page as any change made elsewhere does.
async function relayRequest(harness,method,params){
  const socket=new WebSocket(harness.wsUrl);await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject)});
  try{return await new Promise((resolve,reject)=>{socket.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id===1)message.error?reject(new Error(message.error.message)):resolve(message.result)});socket.send(JSON.stringify({id:1,method,params}))})}
  finally{socket.close()}
}

// The same for a continuity note edited here that another window saves meanwhile: said above Save continuity, where Use saved takes
// it, and Discard changes there takes the notes' edits back.
test("a continuity note saved in another window while it is edited here says so above Save continuity, and Discard changes takes the edits back",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page);
  try{
    await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    const panel=page.getByTestId("goal-panel"),done=panel.getByLabel("Completed work",{exact:true}),row=panel.locator(".continuity-actions"),changed=row.getByRole("status");
    const discard=row.getByRole("button",{name:"Discard changes",exact:true}),question=page.locator("dialog.inspector-text-prompt");
    await panel.getByText("Continuity state",{exact:true}).click();
    await done.click();await page.keyboard.type("Fixed the session refresh",{delay:15});
    await expect.soft(discard,"an edit offers Discard changes by Save continuity").toBeVisible();
    await relayRequest(harness,"thread/continuity/set",{threadId:harness.threads[0].id,completedWork:["Wrote the migration"]});
    await expect(changed,"the note saved in another window is said above Save continuity").toContainText("Completed work changed elsewhere to “Wrote the migration” while you were editing.");
    await expect(done).toHaveValue("Fixed the session refresh");
    await shootBoth(page,"goal-note-changed-elsewhere",()=>changed.scrollIntoViewIfNeeded());
    await changed.getByRole("button",{name:"Use saved",exact:true}).click();
    await expect(done).toHaveValue("Wrote the migration");await expect(changed).toHaveCount(0);await expect(discard).toHaveCount(0);
    await done.click();await page.keyboard.press("End");await page.keyboard.type(" and its rollback",{delay:15});
    await discard.click();
    await expect(question.locator("p")).toHaveText("Discard your changes to the continuity notes?");
    await question.getByRole("button",{name:"Discard changes",exact:true}).click();await expect(question).toHaveCount(0);
    await expect(done).toHaveValue("Wrote the migration");await expect(discard).toHaveCount(0);
  }finally{await harness.close()}
});

test("the Goal panel left open on New task says no thread is open, and the thread opened again shows its goal",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page);
  try{
    const {objective}=await setGoalInPanel(page);
    const rightPanel=page.getByTestId("right-panel"),row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Composer thread"]')});
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"New task",exact:true}).click();
    await expect(rightPanel).toContainText("No active thread");await expect(rightPanel.getByRole("alert")).toHaveCount(0);
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    await expect(objective).toHaveValue("Make the login tests pass");
  }finally{await harness.close()}
});

test("a budget the Goal panel refuses says why in its bar, right above the Update goal pressed, as an alert, and a budget it takes clears it",async({page})=>{
  test.setTimeout(90_000);
  const socket=await relaySocket(page);
  const harness=await openComposerApp(page);
  try{
    const {panel}=await setGoalInPanel(page);
    const update=panel.getByRole("button",{name:"Update goal",exact:true}),cost=panel.getByLabel("Cost budget",{exact:true});
    const refusal=panel.getByRole("alert").filter({hasText:"Cost budget must be a positive number."});
    await panel.getByText("Advanced budgets",{exact:true}).click();
    // Each mode is set at full width, where the right panel leaves the header's theme button clear, and then both widths are tried.
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});
        // The person scrolls down to the budgets, types a cost of 0 and presses Update goal in the bar pinned at the bottom.
        await panel.hover();await page.mouse.wheel(0,600);await expect(panel.locator(".goal-panel-head")).not.toBeInViewport();
        await typeOver(page,cost,"0");await update.click();
        await expect(refusal).toBeInViewport();
        const said=await refusal.boundingBox(),pressed=await update.boundingBox();
        expect(said.y+said.height).toBeLessThanOrEqual(pressed.y);expect(pressed.y-said.y-said.height).toBeLessThan(16);
        await page.screenshot({animations:"disabled",path:auditDir+"goal-budget-refused-"+mode+"-"+width+"x800.png"});
      }
    }
    await page.setViewportSize({width:1280,height:800});await switchMode(page,"dark");
    expect(socket.sent("thread/goal/set")).toHaveLength(1);
    await typeOver(page,cost,"2.5");await update.click();
    await expect(refusal).toHaveCount(0);
    await expect.poll(()=>socket.sent("thread/goal/set").map(params=>params.costBudgetUsd)).toEqual([null,2.5]);
  }finally{await harness.close()}
});

test("a continuity save the harness refuses says why right above Save continuity, clear of the goal's bar, as an alert, and keeps the notes",async({page})=>{
  test.setTimeout(90_000);
  let refusing=true;
  const harness=await openComposerApp(page,{refuse:message=>refusing&&message.method==="thread/continuity/set"?"Continuity store is read-only":null});
  try{
    const {panel}=await setGoalInPanel(page);
    const done=panel.getByLabel("Completed work",{exact:true}),pending=panel.getByLabel("Pending next actions",{exact:true}),save=panel.getByRole("button",{name:"Save continuity",exact:true});
    const refusal=panel.getByRole("alert").filter({hasText:"Continuity store is read-only"}),bar=panel.locator(":scope>.goal-actions");
    await panel.getByText("Continuity state",{exact:true}).click();
    await done.click();await page.keyboard.type("Fixed the session refresh",{delay:15});
    await pending.click();await page.keyboard.type("Run the browser smoke test",{delay:15});
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});
        await save.click();
        await expect(refusal).toBeInViewport();
        const said=await refusal.boundingBox(),pressed=await save.boundingBox(),pinned=await bar.boundingBox();
        expect(said.y+said.height).toBeLessThanOrEqual(pressed.y);expect(pressed.y-said.y-said.height).toBeLessThan(16);
        expect(said.y+said.height).toBeLessThanOrEqual(pinned.y);
        await page.screenshot({animations:"disabled",path:auditDir+"goal-continuity-refused-"+mode+"-"+width+"x800.png"});
      }
    }
    await page.setViewportSize({width:1280,height:800});await switchMode(page,"dark");
    await expect(done).toHaveValue("Fixed the session refresh");await expect(pending).toHaveValue("Run the browser smoke test");
    // Saved once the harness takes it, and the reason goes.
    refusing=false;await save.click();
    await expect(refusal).toHaveCount(0);
    await expect(panel.locator(".goal-continuity-details>summary")).toContainText("2 explicit notes");
  }finally{await harness.close()}
});

test("removing an attachment chip from the keyboard moves focus to the next chip's remove button, then the one before, then the composer",async({page},testInfo)=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page);
  try{
    const composer=page.getByTestId("composer"),remove=name=>chips(page).getByRole("button",{name:"Remove "+name,exact:true});
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      const files=["notes","tool","todo"].map(name=>name+"-"+mode+".txt");
      for(const name of files)await writeFile(testInfo.outputPath(name),"contents of "+name);
      await chooseFiles(page,files.map(name=>testInfo.outputPath(name)));
      await expect(page.locator(".attachment-shelf > span:not(.uploading)")).toHaveCount(3);await expect(chips(page)).toHaveCount(3);
      // The chips stand in the order the files were stored.
      const shown=await chips(page).allTextContents();expect([...shown].sort()).toEqual([...files].sort());
      // Shift+Tab from the composer reaches the last chip's remove button, and once more the middle one.
      await composer.click();await page.keyboard.press("Shift+Tab");await expect(remove(shown[2])).toBeFocused();
      await page.keyboard.press("Shift+Tab");await expect(remove(shown[1])).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(chips(page)).toHaveText([shown[0],shown[2]]);await expect(remove(shown[2])).toBeFocused();
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(remove(shown[2])).toBeFocused();await page.screenshot({animations:"disabled",path:auditDir+"attachment-removed-focus-next-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
      // The last chip goes: the one before takes focus. The last one left goes: the composer takes it.
      await page.keyboard.press("Enter");await expect(chips(page)).toHaveText([shown[0]]);await expect(remove(shown[0])).toBeFocused();
      await page.keyboard.press(" ");await expect(chips(page)).toHaveCount(0);await expect(composer).toBeFocused();
    }
  }finally{await harness.close()}
});

test("an attachment chip removed with the mouse leaves focus in the composer, so the text typed on goes there and removes no other chip",async({page},testInfo)=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page);
  try{
    const composer=page.getByTestId("composer");
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      const files=["alpha","beta","gamma"].map(name=>name+"-"+mode+".txt");
      for(const name of files)await writeFile(testInfo.outputPath(name),"contents of "+name);
      await chooseFiles(page,files.map(name=>testInfo.outputPath(name)));
      await expect(page.locator(".attachment-shelf > span:not(.uploading)")).toHaveCount(3);
      const shown=await chips(page).allTextContents();
      // The person writes, clicks the first chip's X, and writes on: each space would press a remove button that had focus.
      await composer.click();await page.keyboard.type("Check",{delay:20});
      await chips(page).getByRole("button",{name:"Remove "+shown[0],exact:true}).click();
      await expect(chips(page)).toHaveText([shown[1],shown[2]]);await expect(composer).toBeFocused();
      await page.keyboard.type(" these files",{delay:20});
      await expect(composer).toHaveValue("Check these files");await expect(chips(page)).toHaveText([shown[1],shown[2]]);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+"attachment-removed-by-mouse-typing-on-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
      // Clear the draft and the chips for the next mode.
      await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");
      for(const name of [shown[1],shown[2]])await chips(page).getByRole("button",{name:"Remove "+name,exact:true}).click();
      await expect(chips(page)).toHaveCount(0);
    }
  }finally{await harness.close()}
});

// A screenshot as a person pastes it: a PNG drawn in the page, handed over in the paste event's files.
const pasteImage=(page,name)=>page.getByTestId("composer").evaluate(async(node,name)=>{
  const canvas=document.createElement("canvas");canvas.width=64;canvas.height=40;const pen=canvas.getContext("2d");pen.fillStyle="#3b82f6";pen.fillRect(0,0,64,40);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png")),data=new DataTransfer();data.items.add(new File([blob],name,{type:"image/png"}));
  node.dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}));
},name);

test("a message sent with a pasted screenshot and a long pasted log names both files under its text, as the composer's chips did",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page,{replies:[{text:"I see the blue screenshot and the pasted log."}]});
  try{
    const composer=page.getByTestId("composer"),bubble=page.locator(".user-bubble").last(),files=bubble.locator(".user-attachments > span");
    await composer.click();await page.keyboard.type("Here is what I see",{delay:15});
    // The screenshot and a log too long for the draft each become a chip; the draft stays as typed.
    await pasteImage(page,"screenshot.png");await expect(chips(page)).toHaveText(["screenshot.png"]);
    await pasteText(page,"GET /login 500 after the token refresh\n".repeat(1300));
    await expect(chips(page)).toHaveText(["screenshot.png","pasted-context.txt"]);await expect(composer).toHaveValue("Here is what I see");
    await page.keyboard.press("Enter");
    await expect(page.getByText("I see the blue screenshot and the pasted log.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(chips(page)).toHaveCount(0);
    // The message names the files that went with it, as the composer's chips did, under its text.
    await expect(bubble.locator("p")).toHaveText("Here is what I see");
    await expect(files).toHaveText(["screenshot.png","pasted-context.txt"]);
    await expect(files.first().locator("svg")).toBeVisible();
    // Each chip stays inside the message, at both widths and in both modes.
    await shootBoth(page,"sent-message-files",async()=>{
      const [frame,chipBoxes]=await Promise.all([bubble.boundingBox(),files.evaluateAll(nodes=>nodes.map(node=>{const {left,right,top,bottom}=node.getBoundingClientRect();return {left,right,top,bottom}}))]);
      for(const chip of chipBoxes)expect(chip.left>=frame.x&&chip.right<=frame.x+frame.width&&chip.top>=frame.y&&chip.bottom<=frame.y+frame.height,JSON.stringify({chip,frame})).toBe(true);
    });
  }finally{await harness.close()}
});

// The files a message went with are part of what was sent: its thread opened again, or the window reloaded, still names them under
// the message, and Edit from here brings them back to the composer with its text. They showed only until the thread was left.
test("the files a message went with show again under it when its thread is opened again or the window reloads, and Edit from here brings them back",async({page})=>{
  test.setTimeout(120_000);
  const harness=await openComposerApp(page,{replies:[{text:"I see the blue screenshot and the pasted log."}]});
  try{
    const composer=page.getByTestId("composer"),row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Composer thread"]')});
    const bubble=page.locator(".user-bubble").filter({hasText:"Here is what I see"}),files=bubble.locator(".user-attachments > span"),sent=["screenshot.png","pasted-context.txt"];
    await composer.click();await page.keyboard.type("Here is what I see",{delay:15});
    await pasteImage(page,"screenshot.png");await expect(chips(page)).toHaveText(["screenshot.png"]);
    await pasteText(page,"GET /login 500 after the token refresh\n".repeat(1300));await expect(chips(page)).toHaveText(sent);
    await page.keyboard.press("Enter");
    await expect(page.getByText("I see the blue screenshot and the pasted log.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(files).toHaveText(sent);
    // Another view, then the thread again: the message still names its files.
    await page.getByRole("button",{name:"New task",exact:true}).click();await expect(bubble).toHaveCount(0);
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    await expect(bubble.locator("p")).toHaveText("Here is what I see",{timeout:15_000});
    await expect(files,"the files, the thread opened again").toHaveText(sent);
    // The window reloaded: the same.
    await page.reload();await expect(row).toBeVisible({timeout:15_000});
    if(!await row.evaluate(node=>node.classList.contains("active")))await row.locator(".thread-main").click();
    await expect(files,"the files, the window reloaded").toHaveText(sent,{timeout:15_000});await expect(bubble.locator("p")).toHaveText("Here is what I see");
    await shootBoth(page,"sent-message-files-reopened",()=>expect(files.first()).toBeInViewport());
    // Edit from here brings the message back to the composer with its files.
    await bubble.getByRole("button",{name:"Edit from here",exact:true}).click();
    await page.getByRole("dialog").getByRole("button",{name:"Edit from here",exact:true}).click();
    await expect(composer).toHaveValue("Here is what I see",{timeout:15_000});
    await expect(chips(page),"the files come back to the composer with the message").toHaveText(sent);
    await expect(bubble).toHaveCount(0);
  }finally{await harness.close()}
});

// Codex keeps the files a message went with as lines after its text ([Attached image "…" is saved at: …]): its thread opened again
// shows the text alone, with the files named under it, as the bubble did when it was sent. It showed those lines, full paths and all.
test("on Codex, the files a message went with show again under it when its thread is opened again, without the lines Codex keeps them by",async({page})=>{
  test.setTimeout(90_000);
  const thread={id:"codex-sent-files",name:"Codex sent files",preview:"Codex sent files",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const harness=await startCodexHarness(thread,[(turn,{emit,threadId,finish})=>{
    emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});
    const answer={id:"agent-"+turn.id,type:"agentMessage",text:"I see the screenshot and the log."};turn.items.push(answer);emit({method:"item/completed",params:{threadId,turnId:turn.id,item:answer}});finish("completed");
  }]);
  try{
    await routeCodexApp(page,harness,thread);
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Codex sent files"]')}),composer=page.getByTestId("composer");
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);await expect(composer).not.toHaveAttribute("placeholder","Opening thread…");
    const bubble=page.locator(".user-bubble").filter({hasText:"Here is what I see"}),files=bubble.locator(".user-attachments > span"),sent=["screenshot.png","pasted-context.txt"];
    await composer.click();await page.keyboard.type("Here is what I see",{delay:15});
    await pasteImage(page,"screenshot.png");await expect(chips(page)).toHaveText(["screenshot.png"]);
    await pasteText(page,"GET /login 500 after the token refresh\n".repeat(1300));await expect(chips(page)).toHaveText(sent);
    await page.keyboard.press("Enter");
    await expect(page.getByText("I see the screenshot and the log.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(files).toHaveText(sent);
    expect(harness.turns.at(-1).items[0].content[0].text,"Codex keeps the files as lines after the text").toContain('[Attached image "screenshot.png" is saved at: ');
    // Another view, then the thread again: the text alone, with the files under it.
    await page.getByRole("button",{name:"New task",exact:true}).click();await expect(bubble).toHaveCount(0);
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    await expect(bubble.locator("p"),"the message's text, the thread opened again").toHaveText("Here is what I see",{timeout:15_000});
    await expect(files,"the files, the thread opened again").toHaveText(sent);
    await expect(page.getByText(/\[Attached (image|file) /)).toHaveCount(0);
    await shootBoth(page,"codex-sent-message-files-reopened",()=>expect(files.first()).toBeInViewport());
  }finally{await harness.close()}
});

test("removing a context chip from the keyboard moves focus to the chip before it, then to the composer",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page);
  try{
    const composer=page.getByTestId("composer"),context=page.getByTestId("context-chip"),reply=page.locator(".assistant-message-text").last();
    const cite=page.getByRole("button",{name:"Cite selected assistant text"});
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      // The person drags across the reply, then double-clicks its first word, and cites each: two excerpt chips stand over the composer.
      const box=await reply.evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);const {left,right,top,bottom}=range.getBoundingClientRect();return {left,right,y:(top+bottom)/2}});
      await page.mouse.move(box.left+1,box.y);await page.mouse.down();await page.mouse.move(box.right-1,box.y,{steps:6});await page.mouse.up();
      await cite.click();await expect(context).toHaveCount(1);
      await page.mouse.dblclick(box.left+6,box.y);await cite.click();await expect(context).toHaveCount(2);
      const remove=context.getByRole("button",{name:"Remove context"});
      await composer.click();await page.keyboard.press("Shift+Tab");await expect(remove.nth(1)).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(context).toHaveCount(1);await expect(remove.first()).toBeFocused();
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(remove.first()).toBeFocused();await page.screenshot({animations:"disabled",path:auditDir+"context-chip-removed-focus-before-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
      await page.keyboard.press(" ");
      await expect(context).toHaveCount(0);await expect(composer).toBeFocused();
    }
  }finally{await harness.close()}
});

test("/plan puts the plan prompt with what follows it in the composer, ready to send",async({page})=>{
  test.setTimeout(60_000);
  const harness=await openComposerApp(page);
  try{
    const composer=page.getByTestId("composer");
    await composer.click();await page.keyboard.type("/plan the release",{delay:15});await page.keyboard.press("Enter");
    await expect(composer).toHaveValue("Create a clear execution plan, then carry it out. the release");
    await expect(composer).toBeFocused();
    await shootBoth(page,"plan-command",()=>expect(composer).toBeInViewport());
  }finally{await harness.close()}
});

test("Enter held on a partial slash command completes it once, and its repeats neither run it nor send; a press of its own does",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page,{replies:[{text:"Planned the release and carried it out."}]});
  try{
    const composer=page.getByTestId("composer"),menu=page.locator(".slash-menu"),users=page.locator(".user-bubble");
    const plan="Create a clear execution plan, then carry it out. the release";
    await composer.click();await page.keyboard.type("/pl",{delay:20});
    await expect(menu.locator("button.active strong")).toHaveText("/plan");
    // The press completes /plan. Its repeats would run it, and then send the plan prompt it puts in the composer.
    await holdKey(page,"Enter",()=>expect(composer).toHaveValue("/plan "));
    await page.keyboard.type("the release",{delay:15});
    expect(sentTexts(harness),"the messages the thread has").toEqual(["Look at the login page"]);
    await expect(composer).toHaveValue("/plan the release");await expect(menu).toHaveCount(0);await expect(users).toHaveCount(1);
    await shootBoth(page,"held-enter-slash-command",()=>expect(composer).toBeInViewport());
    // A press of its own runs /plan, and the next sends the plan prompt.
    await composer.click();await page.keyboard.press("Control+End");await page.keyboard.press("Enter");
    await expect(composer).toHaveValue(plan);
    await page.keyboard.press("Enter");
    await expect(page.getByText("Planned the release and carried it out.")).toBeVisible({timeout:15_000});
    await expect(users).toHaveCount(2);await expect(users.last()).toContainText(plan);
    expect(harness.turns(harness.threads[0])).toHaveLength(2);
  }finally{await harness.close()}
});

test("Enter held on the @ file menu attaches the file once, and its repeats send nothing; a press of its own sends the message with it",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page,{replies:[{text:"The login redirect is fixed."}]});
  try{
    await mkdir(join(harness.repo,"src"),{recursive:true});
    for(const name of ["login","logout"])await writeFile(join(harness.repo,"src",name+".js"),`export function ${name}(){}\n`);
    const composer=page.getByTestId("composer"),menu=page.getByTestId("file-mention-menu"),users=page.locator(".user-bubble"),context=page.getByTestId("context-chip");
    await composer.click();await page.keyboard.type("Check @log",{delay:20});
    await expect(menu.locator("button.active strong")).toHaveText("login.js");
    // The press attaches login.js. Its repeats would send the message, only begun, with the file.
    await holdKey(page,"Enter",async()=>{await expect(context).toHaveCount(1);await expect(composer).toHaveValue("Check @src/login.js ")});
    await page.keyboard.type("for the redirect",{delay:15});
    expect(sentTexts(harness),"the messages the thread has").toEqual(["Look at the login page"]);
    await expect(composer).toHaveValue("Check @src/login.js for the redirect");await expect(context).toContainText("login.js");await expect(users).toHaveCount(1);
    await shootBoth(page,"held-enter-file-mention",()=>expect(composer).toBeInViewport());
    // A press of its own sends it, with the file.
    await composer.click();await page.keyboard.press("Control+End");await page.keyboard.press("Enter");
    await expect(page.getByText("The login redirect is fixed.")).toBeVisible({timeout:15_000});
    await expect(users).toHaveCount(2);await expect(users.last()).toContainText("Check @src/login.js for the redirect");
    await expect(context).toHaveCount(0);expect(harness.turns(harness.threads[0])).toHaveLength(2);
  }finally{await harness.close()}
});

test("Enter on a draft over the 120,000-character limit does what the disabled Send does: nothing, with no failed card; Send's title says why",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page);
  try{
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),status=page.locator(".composer-status"),users=page.locator(".user-bubble");
    const over="Draft is 120,002 characters · maximum 120,000",chunk="The quick brown fox jumps over the lazy dog. ".repeat(700).slice(0,30_000);
    const length=()=>composer.evaluate(node=>node.value.length);
    // Four pastes reach the limit (a longer one would become an attachment), and two characters typed pass it.
    await composer.click();for(let part=0;part<4;part++)await pasteText(page,chunk);
    await expect.poll(length).toBe(120_000);
    await page.keyboard.type("!!",{delay:20});
    await expect(status).toContainText(over);await expect(send).toBeDisabled();
    await page.keyboard.press("Enter");await frames(page);
    await expect(page.getByText("Message exceeds the 120,000 character limit")).toHaveCount(0);await expect(page.locator(".activity-card-failed")).toHaveCount(0);
    await expect.poll(length).toBe(120_002);await expect(users).toHaveCount(1);
    await expect(send).toHaveAttribute("title",over);
    await shootBoth(page,"over-limit-enter",()=>expect(status).toContainText(over));
    // Two characters fewer, the draft is at the limit and Send is back.
    await composer.click();await page.keyboard.press("Control+End");await page.keyboard.press("Backspace");await page.keyboard.press("Backspace");
    await expect(send).toBeEnabled();await expect(send).toHaveAttribute("title","Send message");await expect(status).toContainText("120,000 / 120,000 chars");
    expect(harness.turns(harness.threads[0])).toHaveLength(1);
  }finally{await harness.close()}
});

// The browser's speech recognition, scripted: "blocked" refuses the microphone as a browser does when its permission is denied
// (an error "not-allowed", then the end), and "listen" keeps listening until stop() is called.
async function scriptedDictation(page){
  await page.addInitScript(()=>{
    window.__dictation={mode:"blocked",starts:0,stops:0};
    class Recognition{
      start(){window.__dictation.starts++;if(window.__dictation.mode==="unavailable")throw new DOMException("Speech recognition is not available.","NotSupportedError");setTimeout(()=>{if(window.__dictation.mode==="blocked"){this.onerror?.({error:"not-allowed"});this.onend?.()}else this.onstart?.()},30)}
      stop(){window.__dictation.stops++;setTimeout(()=>this.onend?.(),30)}
      abort(){this.stop()}
    }
    window.SpeechRecognition=Recognition;window.webkitSpeechRecognition=Recognition;
  });
}

test("dictation says when the microphone is blocked, and a second click on the mic stops listening",async({page})=>{
  test.setTimeout(90_000);
  await scriptedDictation(page);
  const harness=await openComposerApp(page);
  try{
    const mic=page.getByRole("button",{name:"Voice dictation"}),alert=page.getByTestId("composer-alert");
    await mic.click();
    await expect(alert).toHaveText("The microphone is blocked. Allow microphone access for Trebell Code to dictate.");
    await expect(mic).toHaveAttribute("aria-pressed","false");
    await shootBoth(page,"dictation-blocked",()=>expect(alert).toBeInViewport());
    // Allowed, it listens until the mic is clicked again; the note about the blocked microphone goes as it starts.
    await page.evaluate(()=>{window.__dictation.mode="listen"});
    await mic.click();
    await expect(mic).toHaveAttribute("aria-pressed","true");
    await expect(mic).toHaveAttribute("title","Listening… click to stop");
    await expect(alert).toHaveCount(0);
    await mic.click();
    await expect(mic).toHaveAttribute("aria-pressed","false");
    await expect(mic).toHaveAttribute("title","Voice dictation");
    expect(await page.evaluate(()=>window.__dictation)).toEqual({mode:"listen",starts:2,stops:1});
    // A recognition that cannot start says so, and the next click starts a new one.
    await page.evaluate(()=>{window.__dictation.mode="unavailable"});
    await mic.click();
    await expect(alert).toHaveText("Dictation could not start: Speech recognition is not available.");
    await page.evaluate(()=>{window.__dictation.mode="listen"});
    await mic.click();
    await expect(mic).toHaveAttribute("aria-pressed","true");
    await mic.click();
    await expect(mic).toHaveAttribute("aria-pressed","false");
  }finally{await harness.close()}
});

test("the blocked-microphone note gives way to the send: a refused send says it was not sent, and a sent one brings the context meter back",async({page})=>{
  test.setTimeout(90_000);
  await scriptedDictation(page);
  let refusing=true;
  const harness=await openComposerApp(page,{replies:[{text:"Login page checked."}],refuse:message=>refusing&&message.method==="turn/start"?"Provider quota exhausted":null});
  try{
    const composer=page.getByTestId("composer"),alert=page.getByTestId("composer-alert"),mic=page.getByRole("button",{name:"Voice dictation"}),context=page.locator(".composer-context");
    await composer.click();await page.keyboard.type("Check the login page",{delay:15});
    await mic.click();
    await expect(alert).toHaveText("The microphone is blocked. Allow microphone access for Trebell Code to dictate.");
    // The person sends what they typed instead, and the harness refuses the turn.
    await composer.click();await page.keyboard.press("Enter");
    await expect(alert).toHaveText("Not sent: Provider quota exhausted. Your draft is kept.");
    await expect(composer).toHaveValue("Check the login page");
    await shootBoth(page,"dictation-blocked-then-send-refused",()=>expect(alert).toBeInViewport());
    // Blocked again and then sent: the note goes with the message, and the context meter is back.
    refusing=false;
    await mic.click();await expect(alert).toHaveText(/microphone is blocked/);
    await composer.click();await page.keyboard.press("Enter");
    await expect(page.getByText("Login page checked.")).toBeVisible({timeout:15_000});
    await expect(composer).toHaveValue("");
    await expect(alert).toHaveCount(0);await expect(context).toBeVisible();
    await shootBoth(page,"dictation-blocked-then-sent",()=>expect(context).toBeInViewport());
  }finally{await harness.close()}
});

test("a welcome suggestion puts its prompt in the composer with the caret at its end, so Enter sends it",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page,{newTask:true,replies:[{text:"Found the bug and fixed it."}]});
  try{
    const composer=page.getByTestId("composer"),prompt="Find a useful bug, fix it, and run the relevant tests.";
    for(const mode of ["light","dark"]){
      await switchMode(page,mode);
      await page.getByRole("button",{name:"Fix a bug",exact:true}).click();
      await expect(composer).toHaveValue(prompt);
      await expect(composer).toBeFocused();
      expect(await composer.evaluate(node=>[node.selectionStart,node.selectionEnd])).toEqual([prompt.length,prompt.length]);
      for(const width of [1280,900]){await page.setViewportSize({width,height:800});await expect(composer).toBeFocused();await page.screenshot({animations:"disabled",path:auditDir+"welcome-suggestion-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
      if(mode==="light"){await page.keyboard.press("Control+A");await page.keyboard.press("Delete");await expect(composer).toHaveValue("")}
    }
    // Enter, straight after the suggestion, sends it.
    await page.keyboard.press("Enter");
    await expect(page.locator(".user-bubble").last()).toContainText(prompt);
    await expect(composer).toHaveValue("");
  }finally{await harness.close()}
});

test("Ctrl+S held stashes the draft once, and held on the empty composer brings it back once, as any shortcut held runs once",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page);
  // The stash list as the GUI server keeps it, here in the page, so later specs on the shared server keep theirs.
  const stashes=[];let made=0;
  await page.route(/\/api\/stashes(?:\?.*)?$/,route=>{
    const request=route.request(),method=request.method();
    if(method==="POST"){stashes.unshift({...request.postDataJSON(),id:"stash-"+(++made)});return json(route,{ok:true,stash:stashes[0]})}
    if(method==="DELETE"){const at=stashes.findIndex(stash=>stash.id===new URL(request.url()).searchParams.get("id"));if(at>=0)stashes.splice(at,1);return json(route,{ok:true})}
    return json(route,{stashes});
  });
  try{
    const composer=page.getByTestId("composer"),shell=page.locator(".app-shell"),draft="Draft to keep for later";
    const holdCtrl=async(key,pressed)=>{await page.keyboard.down("Control");await holdKey(page,key,pressed);await page.keyboard.up("Control")};
    await composer.click();await page.keyboard.type(draft,{delay:15});
    // The press stashes the draft. Each repeat would find the composer empty and bring the stash back, or stash it again.
    await holdCtrl("s",()=>expect(composer).toHaveValue(""));
    await page.keyboard.type("Another thought",{delay:15});
    await expect(composer).toHaveValue("Another thought");expect(stashes.map(stash=>stash.text)).toEqual([draft]);
    await shootBoth(page,"held-ctrl-s-stashed",()=>expect(composer).toBeInViewport());
    // Held on the empty composer, it brings the draft back once.
    await composer.click();await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");await expect(composer).toHaveValue("");
    await holdCtrl("s",()=>expect(composer).toHaveValue(draft));
    await page.keyboard.type(" today",{delay:15});
    await expect(composer).toHaveValue(draft+" today");expect(stashes).toEqual([]);
    // Ctrl+B held closes the sidebar, and its repeats do not open it again.
    await holdCtrl("b",()=>expect(shell).toHaveClass(/sidebar-collapsed/));
    await expect(shell).toHaveClass(/sidebar-collapsed/);
    await page.keyboard.press("Control+b");await expect(shell).not.toHaveClass(/sidebar-collapsed/);
  }finally{await harness.close()}
});

// An OpenCode thread whose session lists provider agents, so the composer shows the agent picker ("build · primary") beside the
// model picker, on a socket that answers what the window asks as it opens the thread. The catalog's second model has a longer name.
async function openAgentsThread(page){
  const thread={id:"opencode-agents-thread",runtime:"opencode",name:"OpenCode agents",preview:"Agents",agent:"build",cwd:process.cwd(),createdAt:Date.now()/1000-20,updatedAt:Date.now()/1000,status:{type:"idle"},turns:[],
    providerMeta:{session_info_update:{agents:[{name:"build",mode:"primary"},{name:"plan",mode:"primary"},{name:"reviewer",mode:"subagent"}]}}};
  const http=createServer(),wss=new WebSocketServer({noServer:true});
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{
    const message=JSON.parse(String(raw)),method=message.method;if(message.id==null||!method)return;
    const result=method==="initialize"?{userAgent:"composer-agents-fixture"}:method==="thread/list"?{data:[thread],nextCursor:null}:method==="thread/resume"||method==="thread/read"?{thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null}
      :method==="thread/goal/get"?{goal:null}:method==="thread/runtimeInstances/list"?{supported:false,currentInstanceId:null,items:[]}:method.endsWith("/list")?{data:[],nextCursor:null}:{};
    ws.send(JSON.stringify({id:message.id,result}));
  }));
  await new Promise((resolve,reject)=>http.listen(0,"127.0.0.1",resolve).once("error",reject));
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  const status={id:"opencode-default",kind:"opencode",name:"OpenCode",available:true,installed:true,authenticated:true,version:"1.0.0-fixture"};
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",agentRuntimeReady:true,appServerReady:true,wsUrl:`ws://127.0.0.1:${http.address().port}/api/agent/ws`,cwd:process.cwd(),platform:process.platform,version:"composer-agents-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}}));
  await page.route(/\/api\/settings$/,route=>json(route,route.request().method()==="POST"?Object.assign(settings,route.request().postDataJSON()||{}):settings));
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,{agentRuntime:"opencode",ready:true,models:["opencode/fixture-fast","opencode/fixture-large"],defaultModel:"opencode/fixture-fast",error:null,
    metadata:{models:[{id:"opencode/fixture-fast",name:"OpenCode Fixture Fast",agent:"opencode"},{id:"opencode/fixture-large",name:"OpenCode Fixture Large Context",agent:"opencode"}]}}));
  await page.route(/\/api\/agent-runtimes(?:\?.*)?$/,route=>json(route,{selectedRuntime:"opencode",selectedInstanceId:status.id,definitions:[{id:"opencode",name:"OpenCode",protocol:"http"}],instances:[{id:status.id,kind:"opencode",displayName:"OpenCode",enabled:true}],statuses:[status]}));
  for(const [path,value] of [[/\/api\/projects$/,{projects:[]}],[/\/api\/general-workspace$/,{path:process.cwd(),environmentId:null}],[/\/api\/stashes$/,{stashes:[]}],[/\/api\/recovery$/,{enabled:false,items:[]}],
    [/\/api\/checkpoints(?:\?.*)?$/,{checkpoints:[]}],[/\/api\/environment\/themes$/,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}]])await page.route(path,route=>json(route,value));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await page.locator('.thread-main[title="OpenCode agents"]').click();
  await expect(page.locator(".agent-picker")).toHaveValue("build");
  return {async close(){for(const ws of wss.clients)ws.terminate();wss.close();await new Promise(resolve=>http.close(resolve))}};
}
// The composer's right-hand controls as a person finds them: what the page answers at the middle of each (the control itself, or what
// covers it), the ones that run over each other, whether the mic sits between the model picker and Send, and the model's name: whole,
// or cut with an ellipsis, and then whether its row had room left for more of it. That room is the bar's width along the model
// picker's row less the controls on that row and the gaps the layout puts between them (a group's gap, the bar's between the two
// groups, a control's margins), so wherever the row lays its free space (between the groups, or before the right group on a row of its
// own) it counts.
const readComposerRight=page=>page.locator(".composer-bar").evaluate(bar=>{
  const parts={agent:".agent-picker",model:"[data-testid=model-picker]",mic:".mic-btn",send:"[data-testid=send]"},names=Object.keys(parts),nodes={},boxes={},hits={},overlaps=[];
  for(const name of names){nodes[name]=bar.querySelector(parts[name]);boxes[name]=nodes[name].getBoundingClientRect()}
  for(const name of names){const box=boxes[name],at=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);hits[name]=names.find(other=>nodes[other].contains(at))||String(at?.className||at?.tagName)}
  names.forEach((a,index)=>names.slice(index+1).forEach(b=>{const p=boxes[a],q=boxes[b];if(p.left<q.right-1&&q.left<p.right-1&&p.top<q.bottom-1&&q.top<p.bottom-1)overlaps.push(a+"/"+b)}));
  const barBox=bar.getBoundingClientRect(),barStyle=getComputedStyle(bar),model=boxes.model;
  const row=[...bar.children].flatMap(group=>[...group.children].map(node=>({node,group,box:node.getBoundingClientRect()})))
    .filter(({box})=>box.width>0&&box.top<model.bottom-1&&box.bottom>model.top+1).sort((a,b)=>a.box.left-b.box.left);
  let free=0,end=barBox.left+parseFloat(barStyle.paddingLeft),previous=null;
  for(const item of row){
    const style=getComputedStyle(item.node),gap=previous?parseFloat(getComputedStyle(previous.group===item.group?item.group:bar).columnGap)||0:0;
    free+=Math.max(0,item.box.left-parseFloat(style.marginLeft)-gap-end);end=item.box.right+parseFloat(style.marginRight);previous=item;
  }
  free+=Math.max(0,barBox.right-parseFloat(barStyle.paddingRight)-end);
  const label=nodes.model.querySelector("strong"),whole=label.scrollWidth<=label.clientWidth+1;
  const cut=getComputedStyle(label).textOverflow==="ellipsis"?"cut with an ellipsis":"cut";
  return {hits,overlaps,micBetween:boxes.model.right<=boxes.mic.left+1&&boxes.mic.right<=boxes.send.left+1,label:whole?"whole":free<=2?cut+", its row full":`${cut}, ${Math.round(free)} px free in its row`};
});
const controlsClear={hits:{agent:"agent",model:"model",mic:"mic",send:"send"},overlaps:[],micBetween:true};

// Beside OpenCode's agent picker, the model picker kept its whole label in a group held to about half the composer, so from 1000 wide
// down it ran over the mic and a click there opened the model picker. The mic stays between the model picker and Send at every width,
// in both modes, and a name too long for its pill is cut with an ellipsis only where its row has no room left for it (a cap of 32vw
// cut the longer name at 700 with about 46 px of the row free), whole in the open picker.
test("beside OpenCode's agent picker the mic stays clickable between the model picker and Send at every width, the model's name whole or cut with an ellipsis",async({page})=>{
  test.setTimeout(150_000);
  await scriptedDictation(page);
  const fixture=await openAgentsThread(page);
  try{
    const picker=page.getByTestId("model-picker"),mic=page.getByRole("button",{name:"Voice dictation"}),menu=page.locator(".model-picker-menu");
    const shown=expect.stringMatching(/^(whole|cut with an ellipsis, its row full)$/);
    await expect(picker).toContainText("OpenCode Fixture Fast");
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      for(const width of [1280,1100,1000,900,800,700]){
        await page.setViewportSize({width,height:800});
        await expect.poll(()=>readComposerRight(page),{message:`the composer's controls at ${width}x800 in ${mode}`}).toEqual({...controlsClear,label:shown});
        await mic.click({trial:true,timeout:5000});
        if([1280,900,700].includes(width))await page.screenshot({animations:"disabled",path:auditDir+`agent-picker-composer-${mode}-${width}x800.png`});
      }
    }
    // The longer name, picked from the open picker, is whole there. In the composer it is whole wherever its row has room for it, and
    // cut with an ellipsis only where that row is full, clear of the mic: at 1280 and 700, and with the right panel open at 1280 and
    // 1100, which stacks the composer's two groups and, at 1100, leaves the right group's row too narrow for the whole name.
    await page.setViewportSize({width:1280,height:800});await switchMode(page,"dark");
    await picker.click();await expect(menu).toBeVisible();
    expect(await menu.locator(":scope>button strong").evaluateAll(nodes=>nodes.map(node=>node.textContent+(node.scrollWidth>node.clientWidth+1?" (cut)":"")))).toEqual(["OpenCode Fixture Fast","OpenCode Fixture Large Context"]);
    await menu.getByRole("button",{name:/OpenCode Fixture Large Context/}).click();
    await expect(menu).toHaveCount(0);await expect(picker).toContainText("OpenCode Fixture Large Context");
    const panelToggle=page.getByTestId("right-panel-toggle"),panel=page.getByTestId("right-panel");
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      for(const width of [1280,700]){
        await page.setViewportSize({width,height:800});
        await expect.poll(()=>readComposerRight(page),{message:`the longer name at ${width}x800 in ${mode}`}).toEqual({...controlsClear,label:shown});
        await mic.click({trial:true,timeout:5000});
      }
      await page.screenshot({animations:"disabled",path:auditDir+`agent-picker-longer-model-${mode}-700x800.png`});
      await page.setViewportSize({width:1280,height:800});await panelToggle.click();await expect(panel).toBeVisible();
      for(const width of [1280,1100]){
        await page.setViewportSize({width,height:800});
        await expect.poll(()=>readComposerRight(page),{message:`the longer name beside the right panel at ${width}x800 in ${mode}`}).toEqual({...controlsClear,label:shown});
        await mic.click({trial:true,timeout:5000});
        await page.screenshot({animations:"disabled",path:auditDir+`agent-picker-longer-model-panel-${mode}-${width}x800.png`});
      }
      await page.setViewportSize({width:1280,height:800});await panelToggle.click();await expect(panel).toHaveCount(0);
    }
    // At 900, a click where the mic is goes to the mic: it says the microphone is blocked, and the model picker stays closed.
    await page.setViewportSize({width:1280,height:800});await switchMode(page,"dark");await page.setViewportSize({width:900,height:800});
    await expect.poll(()=>readComposerRight(page),{message:"the composer's controls at 900x800"}).toEqual({...controlsClear,label:shown});
    const box=await mic.boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
    await expect(page.getByTestId("composer-alert")).toHaveText("The microphone is blocked. Allow microphone access for Trebell Code to dictate.");
    await expect(menu).toHaveCount(0);
  }finally{await fixture.close()}
});

// A reply long enough to scroll that ends with a line with a link in it, then its done chip: what a person rereads, clicks and cites
// while writing.
const LONG_REPLY=[...Array.from({length:30},(_,index)=>`Paragraph ${index+1} of the reply about the login flow and its session token.`),"Last line of the reply: sign out on a 401, see the [session notes](https://example.invalid/notes)."].join("\n\n");
// The end of the last reply against the composer: whether the view is at its end, and for the reply's last line, the link in it and
// the done chip, "clear" when it is above the composer and its chips and the page answers it at its middle, or else where it is and
// what the page answers there.
const readReplyEnd=page=>page.evaluate(()=>{
  const scroll=document.querySelector(".conversation-scroll"),wrap=document.querySelector(".composer-wrap"),chip=wrap.querySelector(".attachment-shelf>span");
  const top=Math.min(wrap.getBoundingClientRect().top,chip?chip.getBoundingClientRect().top:Infinity);
  const line=[...scroll.querySelectorAll("p")].filter(node=>node.textContent.startsWith("Last line of the reply")).pop();
  const clear=(node,x)=>{
    if(!node)return "missing";
    const box=node.getBoundingClientRect(),at=document.elementFromPoint(x(box),box.top+box.height/2);
    return box.bottom<=top+0.5&&node.contains(at)?"clear":`${Math.round(box.top)}-${Math.round(box.bottom)} answers ${String(at?.className||at?.tagName)}${at?.closest(".composer-wrap")?" in the composer":""}, composer top ${Math.round(top)}`;
  };
  return {atEnd:scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<=1,line:clear(line,box=>box.left+20),link:clear(line?.querySelector("a"),box=>box.left+box.width/2),
    chip:clear([...scroll.querySelectorAll("[data-testid=turn-outcome]")].pop(),box=>box.left+box.width/2)};
});
const replyEndClear={atEnd:true,line:"clear",link:"clear",chip:"clear"};
const distanceFromEnd=page=>page.locator(".conversation-scroll").evaluate(node=>Math.round(node.scrollHeight-node.clientHeight-node.scrollTop));
// The first paragraph wholly below the view's top, and where it is on screen.
const firstParagraphInView=page=>page.locator(".conversation-scroll").evaluate(node=>{
  const top=node.getBoundingClientRect().top,paragraph=[...node.querySelectorAll("p")].find(item=>item.getBoundingClientRect().top>=top);
  return paragraph?{text:paragraph.textContent.slice(0,13),top:Math.round(paragraph.getBoundingClientRect().top)}:null;
});
// The mouse wheel over the thread, as a person scrolls it, then the view once it holds still.
async function wheelThread(page,dy,steps=1){
  const view=await page.locator(".conversation-scroll").boundingBox();
  await page.mouse.move(view.x+view.width/2,view.y+Math.min(200,view.height/2));
  for(let step=0;step<steps;step++)await page.mouse.wheel(0,dy);
  const top=()=>page.locator(".conversation-scroll").evaluate(node=>Math.round(node.scrollTop));
  await expect.poll(async()=>{const before=await top();await page.waitForTimeout(120);return before===await top()}).toBe(true);
}
// A message of several lines, written with Shift+Enter between them.
async function typeLines(page,count){
  await page.keyboard.type("Line 1 of a longer message",{delay:10});
  for(let line=2;line<=count;line++){await page.keyboard.press("Shift+Enter");await page.keyboard.type("Line "+line,{delay:10})}
}

// The thread's scroll area ended where the composer's top is with an empty draft, so a draft of several lines (the composer growing
// from 115 to 235 px) and its attachment chips covered the end of the last reply even with the thread at its end, and the empty
// attachment shelf, drawn over the reply, took the clicks on its last line. The end of the reply stays clear of the composer however
// tall it grows, a thread at its end stays there, and one scrolled up keeps what is being read in place.
test("a draft of several lines and its attachment chips leave the end of the last reply clear to read, click and cite, and a thread scrolled up keeps its place",async({page})=>{
  test.setTimeout(120_000);
  const harness=await openComposerApp(page,{turns:[{user:"Explain the login flow",items:[replyItem("login-reply",LONG_REPLY)]}]});
  try{
    const composer=page.getByTestId("composer"),lastLine=page.locator(".conversation-scroll p").filter({hasText:"Last line of the reply"});
    await expect(lastLine).toBeVisible();
    await expect.poll(()=>readReplyEnd(page),{message:"the empty composer"}).toEqual(replyEndClear);
    // Scrolled up to reread, the person writes eight lines: the paragraph at the view's top stays where it is.
    await wheelThread(page,-400);
    const reading=await firstParagraphInView(page);
    await composer.click();await typeLines(page,8);await expect(composer).toHaveValue(/\nLine 8$/);
    await expect.poll(()=>firstParagraphInView(page),{message:"the paragraph being read"}).toEqual(reading);
    expect(await distanceFromEnd(page)).toBeGreaterThan(48);
    // Scrolled to its end, the end of the reply shows above the grown composer, and the empty attachment shelf takes no room over it.
    await wheelThread(page,1200,6);
    await expect.poll(()=>readReplyEnd(page),{message:"an eight-line draft, the thread scrolled to its end"}).toEqual(replyEndClear);
    await expect(page.locator(".attachment-shelf")).toBeHidden();
    // At its end, the thread stays there as the draft goes and grows again, with no scrolling.
    await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");await expect(composer).toHaveValue("");
    await expect.poll(()=>readReplyEnd(page),{message:"the draft cleared"}).toEqual(replyEndClear);
    await typeLines(page,8);
    await expect.poll(()=>readReplyEnd(page),{message:"eight lines written again at the thread's end"}).toEqual(replyEndClear);
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      for(const width of [1280,900,700]){
        await page.setViewportSize({width,height:800});
        await expect.poll(()=>readReplyEnd(page),{message:`an eight-line draft at ${width}x800 in ${mode}`}).toEqual(replyEndClear);
        await page.screenshot({animations:"disabled",path:auditDir+`grown-draft-reply-end-${mode}-${width}x800.png`});
      }
    }
    await page.setViewportSize({width:1280,height:800});await switchMode(page,"dark");
    await expect.poll(()=>readReplyEnd(page),{message:"back at 1280x800"}).toEqual(replyEndClear);
    // A triple-click on the last line selects it and offers Cite, and its link takes a click.
    const box=await lastLine.boundingBox();
    await page.mouse.click(box.x+30,box.y+box.height/2,{clickCount:3});
    expect(await page.evaluate(()=>String(getSelection()))).toMatch(/^Last line of the reply/);
    await expect(page.getByTestId("assistant-selection-cite")).toBeVisible();
    await lastLine.getByRole("link",{name:"session notes"}).click({trial:true,timeout:5000});
    // Two pasted screenshots: their chips sit above the composer, clear of the reply's text, and the thread stays at its end.
    await composer.click();await pasteImage(page,"screen-1.png");await pasteImage(page,"screen-2.png");
    await expect(chips(page)).toHaveText(["screen-1.png","screen-2.png"]);
    await expect.poll(()=>readReplyEnd(page),{message:"eight lines and two screenshots"}).toEqual(replyEndClear);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:auditDir+`grown-draft-with-files-reply-end-${mode}-1280x800.png`})}
  }finally{await harness.close()}
});

// The desktop shell's agent browser, as far as the Browser panel's Attach screenshot goes: each capture is a small PNG.
function screenshotBrowser(){
  const state={open:false,url:"",title:"",canGoBack:false,canGoForward:false,loading:false,width:1280,height:800};
  Object.defineProperty(window,"trebellDesktop",{configurable:true,value:{browser:{state:async()=>state,onState:()=>()=>{},
    screenshot:async()=>({dataUrl:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="})}}});
}
// Attach screenshot pressed in the Browser panel count times, each press waited on until its chip is in the composer.
async function attachScreenshots(page,count){
  const capture=page.getByTestId("right-panel").getByRole("button",{name:"Attach screenshot",exact:true}),chip=page.getByTestId("context-chip"),before=await chip.count();
  for(let press=1;press<=count;press++){await capture.click();await expect(chip).toHaveCount(before+press)}
}
// Each of the new task's suggestions against the composer: "clear" when it is wholly above the composer and its chips, inside the
// conversation's view, and the page answers it at its middle, or else where it is and what the page answers there.
const readSuggestions=page=>page.evaluate(()=>{
  const wrap=document.querySelector(".chat-workspace .composer-wrap"),view=document.querySelector(".chat-workspace .conversation-scroll").getBoundingClientRect();
  const top=Math.min(wrap.getBoundingClientRect().top,...[...wrap.querySelectorAll(".attachment-shelf>span")].map(chip=>chip.getBoundingClientRect().top));
  return [...document.querySelectorAll(".welcome .suggestions button")].map(button=>{
    const box=button.getBoundingClientRect(),at=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
    return box.bottom<=top+0.5&&box.top>=view.top&&box.bottom<=view.bottom+0.5&&button.contains(at)?"clear":`${button.textContent} ${Math.round(box.top)}-${Math.round(box.bottom)} answers ${String(at?.className||at?.tagName)}${at?.closest(".composer-wrap")?" in the composer":""}, composer top ${Math.round(top)}, view ${Math.round(view.top)}-${Math.round(view.bottom)}`;
  });
});
const suggestionsClear=["clear","clear","clear"];

// Browser screenshots attached in the Browser panel grow the composer a row of chips for every two or three. The thread ends above
// them, but the new task's welcome kept its place over the composer, so a dozen of them beside the open panel covered the lower half
// of its suggestions, as did fewer under a draft of several lines. The welcome makes room for the chips, the panel open or closed and
// in narrower windows, and keeps its place as a draft grows; the thread at its end keeps the end of its last reply clear of ten.
test("ten Browser screenshots attached leave the end of the last reply clear above the composer, and a dozen the new task's suggestions",async({page})=>{
  test.setTimeout(150_000);
  await page.addInitScript(screenshotBrowser);
  const harness=await openComposerApp(page,{turns:[{user:"Explain the session flow",items:[replyItem("session-reply",LONG_REPLY)]},{user:"Explain the login flow",items:[replyItem("login-reply",LONG_REPLY)]}]});
  try{
    const composerTop=()=>page.locator(".chat-workspace .composer-wrap").evaluate(node=>Math.round(node.getBoundingClientRect().top));
    await page.locator(".sidebar").getByRole("button",{name:"Browser",exact:true}).click();
    await expect(page.getByTestId("right-panel").getByRole("button",{name:"Attach screenshot",exact:true})).toBeVisible();
    // On the thread scrolled to its end, ten chips leave the end of its last reply clear.
    await wheelThread(page,1200,6);
    const before=await composerTop();
    await attachScreenshots(page,10);
    await wheelThread(page,1200,6);
    await expect.poll(()=>readReplyEnd(page),{message:"ten chips, the thread at its end"}).toEqual(replyEndClear);
    test.info().annotations.push({type:"thread with ten chips",description:JSON.stringify({composerTopBefore:before,composerTopAfter:await composerTop(),end:await readReplyEnd(page),lastLineBottom:await page.locator(".conversation-scroll p").filter({hasText:"Last line of the reply"}).last().evaluate(node=>Math.round(node.getBoundingClientRect().bottom)),viewBottom:await page.locator(".conversation-scroll").evaluate(node=>Math.round(node.getBoundingClientRect().bottom))})});
    for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:auditDir+`ten-chips-reply-end-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    // On New task, a dozen chips leave its suggestions clear, the Browser panel open (a narrow conversation, six rows of chips) or closed.
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"New task",exact:true}).click();
    await expect(page.locator(".welcome h1")).toHaveText("What do you want to build?");await expect(page.getByTestId("context-chip")).toHaveCount(0);
    await attachScreenshots(page,12);
    await expect.poll(()=>readSuggestions(page),{message:"a dozen chips on New task, the Browser panel open"}).toEqual(suggestionsClear);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await page.screenshot({animations:"disabled",path:auditDir+`dozen-chips-welcome-${mode}-1280x800.png`})}
    await switchMode(page,"dark");
    await page.getByRole("button",{name:"Close right panel"}).click();await expect(page.getByTestId("right-panel")).toHaveCount(0);
    for(const width of [1280,900,700]){
      await page.setViewportSize({width,height:800});
      await expect.poll(()=>readSuggestions(page),{message:`a dozen chips on New task at ${width}x800, the panel closed`}).toEqual(suggestionsClear);
      if(width<1280)await page.screenshot({animations:"disabled",path:auditDir+`dozen-chips-welcome-dark-${width}x800.png`});
    }
    await page.setViewportSize({width:1280,height:800});
    await page.getByRole("button",{name:"Fix a bug",exact:true}).click({trial:true,timeout:5000});
    // A draft of several lines leaves the welcome where it was, the chips still clear.
    const placed=await page.locator(".welcome h1").evaluate(node=>Math.round(node.getBoundingClientRect().top));
    await page.getByTestId("composer").click();await typeLines(page,6);
    await expect.poll(()=>readSuggestions(page),{message:"a six-line draft and a dozen chips on New task"}).toEqual(suggestionsClear);
    expect(await page.locator(".welcome h1").evaluate(node=>Math.round(node.getBoundingClientRect().top)),"the welcome keeps its place as the draft grows").toBe(placed);
  }finally{await harness.close()}
});

// The composer is off while a send goes (Sending…), and the browser drops the keyboard it had there, or on Send, on the page: the next
// message typed went nowhere. Once the send has gone the keyboard is in the composer again, after Enter and after Send, while the reply
// runs (Queue a follow-up…) and after it, so the next message typed at once lands there. A person typing types at 20 ms a key.
const typeOn=(page,text)=>page.keyboard.type(text,{delay:20});
const heldGate=()=>{let open=()=>{};const promise=new Promise(resolve=>{open=resolve});return {promise,open}};
// The page at 1280 and 900 wide in the mode it is in, with the keyboard left where it is.
async function shootHere(page,name){
  const mode=await page.locator("html").getAttribute("data-mode");
  for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-"+width+"x800.png"})}
  await page.setViewportSize({width:1280,height:800});
}

test("the keyboard is back in the composer once a send has gone, after Enter and after Send, while the reply runs and after it, so the next message typed lands there",async({page})=>{
  test.setTimeout(120_000);
  const slow=heldGate();
  const harness=await openComposerApp(page,{replies:[{text:"Reply number one."},async()=>{await slow.promise;return {text:"Reply number two, after a slow provider."}},{text:"Reply number three."},{text:"Reply number four."}]});
  try{
    const composer=page.getByTestId("composer"),users=page.locator(".user-bubble"),queued=page.locator(".queued-message"),reply=text=>page.getByText(text,{exact:true});
    const idle="Ask Trebell Code anything…";
    // Enter (dark): once the message is in and the composer is on again, the next message, typed at once, lands there.
    await composer.click();await typeOn(page,"First message");await page.keyboard.press("Enter");
    await expect(users.last()).toContainText("First message");await expect(composer).toBeEnabled();
    await typeOn(page,"Second message");
    await expect(composer,"the keyboard after Enter").toBeFocused();await expect(composer).toHaveValue("Second message");
    await expect(reply("Reply number one.")).toBeVisible({timeout:15_000});await expect(composer).toHaveAttribute("placeholder",idle);
    await shootHere(page,"keyboard-after-enter");
    // A slow reply runs: the follow-up typed at once, as the composer asks for it, lands there; Enter queues it, and the keyboard is
    // still there for the next.
    await page.keyboard.press("Enter");
    await expect(composer).toHaveAttribute("placeholder","Queue a follow-up…");
    await typeOn(page,"A follow-up typed while it runs");
    await expect(composer,"the keyboard while the reply runs").toBeFocused();await expect(composer).toHaveValue("A follow-up typed while it runs");
    await shootHere(page,"keyboard-follow-up-while-running");
    await page.keyboard.press("Enter");
    await expect(queued).toHaveCount(1);await expect(composer).toBeEnabled();await expect(composer).toHaveValue("");
    await typeOn(page,"One more");
    await expect(composer,"the keyboard after a follow-up is queued").toBeFocused();await expect(composer).toHaveValue("One more");
    await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");
    // The slow reply ends, and the queued follow-up goes and is answered.
    slow.open();
    await expect(reply("Reply number three.")).toBeVisible({timeout:15_000});await expect(composer).toHaveAttribute("placeholder",idle);
    // Send (light): the click puts the keyboard on Send, which goes off with the composer; it comes back to the composer.
    await switchMode(page,"light");
    await composer.click();await typeOn(page,"Fourth message");await page.getByTestId("send").click();
    await expect(users.last()).toContainText("Fourth message");await expect(composer).toBeEnabled();
    await typeOn(page,"After the button");
    await expect(composer,"the keyboard after Send").toBeFocused();await expect(composer).toHaveValue("After the button");
    await expect(reply("Reply number four.")).toBeVisible({timeout:15_000});
    await shootHere(page,"keyboard-after-send-button");
    expect(sentTexts(harness)).toEqual(["Look at the login page","First message","Second message","A follow-up typed while it runs","Fourth message"]);
  }finally{slow.open();await harness.close()}
});

test("on Codex the keyboard is back in the composer once a send has gone, after Enter while the turn runs and after Send",async({page})=>{
  test.setTimeout(90_000);
  const running=heldGate();
  const thread={id:"codex-keyboard",name:"Codex keyboard",preview:"Codex keyboard",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const answer=(text,wait=null)=>async(turn,{emit,threadId,finish})=>{
    emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});
    await wait;
    const item={id:"agent-"+turn.id,type:"agentMessage",text};turn.items.push(item);emit({method:"item/completed",params:{threadId,turnId:turn.id,item}});finish("completed");
  };
  const harness=await startCodexHarness(thread,[answer("Codex reply one.",running.promise),answer("Codex reply two.")]);
  try{
    await routeCodexApp(page,harness,thread);
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Codex keyboard"]')}),composer=page.getByTestId("composer");
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);await expect(composer).not.toHaveAttribute("placeholder","Opening thread…");
    // Enter (dark): while Codex runs the turn, the follow-up typed at once lands in the composer.
    await composer.click();await typeOn(page,"Codex message");await page.keyboard.press("Enter");
    await expect(composer).toHaveAttribute("placeholder","Queue a follow-up…");
    await typeOn(page,"A follow-up for Codex");
    await expect(composer,"the keyboard after Enter on Codex").toBeFocused();await expect(composer).toHaveValue("A follow-up for Codex");
    await shootHere(page,"codex-keyboard-after-enter");
    await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");
    running.open();
    await expect(page.getByText("Codex reply one.",{exact:true})).toBeVisible({timeout:15_000});await expect(composer).toHaveAttribute("placeholder","Ask Trebell Code anything…");
    // Send (light): the keyboard comes back from Send to the composer, and the next message lands there.
    await switchMode(page,"light");
    await composer.click();await typeOn(page,"Codex by the button");await page.getByTestId("send").click();
    await expect(page.getByText("Codex reply two.",{exact:true})).toBeVisible({timeout:15_000});
    await typeOn(page,"Next for Codex");
    await expect(composer,"the keyboard after Send on Codex").toBeFocused();await expect(composer).toHaveValue("Next for Codex");
    await shootHere(page,"codex-keyboard-after-send-button");
    expect(harness.turns.map(turn=>turn.items[0].content[0].text)).toEqual(["Codex message","Codex by the button"]);
  }finally{running.open();await harness.close()}
});

// The keyboard comes back only to a page that has no other place for it: a field clicked, or the palette opened with its key, while the
// send goes keeps it, and what is typed on goes there.
test("a field clicked or the palette opened while a send goes keeps the keyboard once the send has gone",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page,{replies:[{text:"Reply number one."},{text:"Reply number two."}]});
  // The send waits on its repository context while hold is a gate not yet opened.
  let hold=null;await page.route(/\/api\/context\/packet$/,async route=>{await hold?.promise;await route.fallback()});
  try{
    const composer=page.getByTestId("composer"),search=page.getByRole("textbox",{name:"Search threads"}),palette=page.getByTestId("command-palette");
    // The sidebar's search, clicked while the composer says Sending… (dark).
    hold=heldGate();
    await composer.click();await typeOn(page,"First message");await page.keyboard.press("Enter");
    await expect(composer).toHaveAttribute("placeholder","Sending…");
    await search.click();await typeOn(page,"Compo");
    hold.open();
    await expect(page.getByText("Reply number one.",{exact:true})).toBeVisible({timeout:15_000});await expect(composer).toBeEnabled();
    await typeOn(page,"ser");
    await expect(search,"the field clicked while the send went").toBeFocused();await expect(search).toHaveValue("Composer");await expect(composer).toHaveValue("");
    await shootHere(page,"keyboard-field-clicked-during-send");
    await page.keyboard.press("Escape");await expect(search).toHaveValue("");
    // The palette, opened with Ctrl+K while the composer says Sending… (light).
    await switchMode(page,"light");
    hold=heldGate();
    await composer.click();await typeOn(page,"Second message");await page.keyboard.press("Enter");
    await expect(composer).toHaveAttribute("placeholder","Sending…");
    await page.keyboard.press("Control+K");await expect(palette).toBeVisible();
    hold.open();
    await expect(page.getByText("Reply number two.",{exact:true})).toBeVisible({timeout:15_000});await expect(composer).toBeEnabled();
    await typeOn(page,"usage");
    const query=palette.getByRole("textbox");
    await expect(query,"the palette opened while the send went").toBeFocused();await expect(query).toHaveValue("usage");await expect(composer).toHaveValue("");
    await shootHere(page,"keyboard-palette-opened-during-send");
    await page.keyboard.press("Escape");await expect(palette).toBeHidden();
    expect(sentTexts(harness)).toEqual(["Look at the login page","First message","Second message"]);
  }finally{hold?.open();await harness.close()}
});
