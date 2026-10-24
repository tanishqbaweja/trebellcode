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
// refuse(message), when given, names an error to answer a request with instead of the relay (a harness refusing it), and hold(message)
// a promise the request waits on before it goes to the relay (a harness slow to answer it); answer(message) one its answer waits on
// before it reaches the page, while what the relay says meanwhile (the notification of what it did) goes on. turns are the thread's
// turns from before the window opened, in place of its one short reply. others names more threads, each with a short reply.
async function openComposerApp(page,{newTask=false,replies=[],refuse=null,hold=null,answer=null,turns=[{user:"Look at the login page",items:[replyItem("seed-reply-1","The login page renders.")]}],others=[]}={}){
  const harness=await startRelayHarness({replies});
  harness.seedThread("Composer thread",turns);
  others.forEach((name,index)=>harness.seedThread(name,[{user:"Look at "+name,items:[replyItem("other-reply-"+index,name+" is ready.")]}]));
  await routeRelayApp(page,harness);
  if(refuse||hold||answer)await page.routeWebSocket(harness.wsUrl,ws=>{
    const server=ws.connectToServer(),asked=new Map();
    ws.onMessage(async message=>{
      let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
      const request=parsed?.id!=null&&parsed.method?parsed:null,refusal=request&&refuse?refuse(request):null;
      if(refusal){ws.send(JSON.stringify({id:parsed.id,error:{code:-32000,message:refusal}}));return}
      if(request)asked.set(request.id,request);
      const wait=request&&hold?hold(request):null;if(wait)await wait;
      server.send(message);
    });
    if(answer)server.onMessage(async message=>{
      let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
      const request=parsed?.id!=null&&!parsed.method?asked.get(parsed.id):null,wait=request?answer(request):null;
      if(wait)await wait;
      ws.send(message);
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
// until release() sends them on (a slow harness), or release(reason) refuses them with reason (a slow harness that refuses them);
// drop() closes the socket and keeps the window from connecting again until back() (a harness that goes away and comes back);
// answer(method,change) changes what the relay answers to that method from then on.
async function relaySocket(page){
  const sent=[],sockets=[],held=[],answers=new Map();let holding=null,away=false;
  await page.routeWebSocket(/\/api\/agent\/ws$/,ws=>{
    if(away){ws.close({code:1011,reason:"harness down"}).catch(()=>{});return}
    const server=ws.connectToServer(),asked=new Map();sockets.push({ws,server});
    ws.onMessage(message=>{
      let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
      if(parsed?.method){sent.push(parsed);if(parsed.id!=null)asked.set(parsed.id,parsed.method)}
      if(parsed?.method&&parsed.method===holding)held.push(reason=>reason?ws.send(JSON.stringify({id:parsed.id,error:{code:-32000,message:reason}})):server.send(message));else server.send(message);
    });
    server.onMessage(message=>{
      let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
      const change=parsed?.result&&answers.get(asked.get(parsed.id));
      ws.send(change?JSON.stringify({...parsed,result:change(parsed.result)}):message);
    });
  });
  return {
    sent:method=>sent.filter(message=>message.method===method).map(message=>message.params||{}),
    hold(method){holding=method},release(reason){holding=null;for(const send of held.splice(0))send(reason)},
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
    // The harness takes its time over the save, which Update goal says, and the person goes on typing meanwhile.
    socket.hold("thread/goal/set");
    await update.click();await expect(panel.getByRole("button",{name:"Saving…",exact:true})).toHaveAttribute("aria-busy","true");
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

// A Goal edit left unsaved went without a word when the person opened another thread and came back: the panel kept one put-away
// draft, and the other thread's panel dropped it. Each thread keeps its own until it is saved or discarded, and another thread's
// panel starts from its own goal or its own draft, opened from the sidebar or from the palette.
test("a Goal edit and note left unsaved on a thread are still there when the person opens another thread and comes back, and each thread keeps its own",async({page})=>{
  test.setTimeout(120_000);
  const socket=await relaySocket(page);
  const harness=await openComposerApp(page,{others:["Second thread"]});
  try{
    // The first thread's goal was set elsewhere (another window), as one set before this window opened was.
    await relayRequest(harness,"thread/goal/set",{threadId:harness.threads[0].id,objective:"Make the login tests pass",completionConditions:["Login tests pass"]});
    await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    const panel=page.getByTestId("goal-panel"),objective=panel.getByLabel("Objective",{exact:true});
    await expect(objective).toHaveValue("Make the login tests pass");
    const done=panel.getByLabel("Completed work",{exact:true}),discard=panel.locator(":scope>.goal-actions").getByRole("button",{name:"Discard changes",exact:true});
    const row=name=>page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)}),composer=page.getByTestId("composer");
    const opened=async name=>{await expect(row(name)).toHaveClass(/active/);await expect(composer).not.toHaveAttribute("placeholder","Opening thread…");await painted(page)};
    const notes=async()=>{if(!await done.isVisible())await panel.getByText("Continuity state",{exact:true}).click();return done};
    await typeOver(page,objective,"Make the login and signup tests pass");
    await (await notes()).click();await page.keyboard.type("Fixed the session refresh",{delay:15});
    // The second thread, opened from the sidebar, shows its own goal, none, with nothing of the first thread's edits.
    await row("Second thread").locator(".thread-main").click();await opened("Second thread");
    await expect(objective,"the second thread's own objective").toHaveValue("");await expect(await notes()).toHaveValue("");
    await expect(panel.getByRole("button",{name:"Set goal",exact:true})).toBeVisible();await expect(discard).toHaveCount(0);
    await objective.click();await page.keyboard.type("Ship the billing page",{delay:15});
    // Back on the first thread its edits are as they were left, nothing is said to have changed elsewhere, and Discard is offered.
    await row("Composer thread").locator(".thread-main").click();await opened("Composer thread");
    await expect(objective,"the first thread's unsaved objective, back on it").toHaveValue("Make the login and signup tests pass");
    await expect(await notes(),"the first thread's unsaved note, back on it").toHaveValue("Fixed the session refresh");
    await expect(panel.locator(".goal-field-changed"),"nothing changed elsewhere").toHaveCount(0);await expect(discard).toBeVisible();
    await shootBoth(page,"goal-draft-after-another-thread",()=>objective.scrollIntoViewIfNeeded());
    // The second thread opened from the palette keeps its own edit too.
    await composer.click();await page.keyboard.press("Control+K");
    const palette=page.getByTestId("command-palette");
    await page.keyboard.type("Second thread",{delay:20});await expect(palette.locator(".command-palette-item.selected.kind-thread")).toContainText("Second thread");
    await page.keyboard.press("Enter");await expect(palette).toBeHidden();await opened("Second thread");
    await expect(objective,"the second thread's unsaved objective, opened from the palette").toHaveValue("Ship the billing page");
    // Back on the first thread, Update goal saves its edit.
    await row("Composer thread").locator(".thread-main").click();await opened("Composer thread");
    await expect(objective).toHaveValue("Make the login and signup tests pass");
    await panel.getByRole("button",{name:"Update goal",exact:true}).click();
    await expect.poll(()=>socket.sent("thread/goal/set").map(params=>params.objective)).toEqual(["Make the login and signup tests pass"]);
    await expect(panel.getByRole("button",{name:"Update goal",exact:true})).toBeEnabled();await expect(discard).toHaveCount(0);
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

// The keyboard taken on to target with Tab, as a person reaches a button from the field they were in.
async function tabTo(page,target,most=25){
  for(let presses=0;presses<most&&!await target.evaluate(node=>node===document.activeElement);presses++)await page.keyboard.press("Tab");
  await expect(target).toBeFocused();
}
// The Goal panel's writes (the goal's, or the notes' with notes), each held from when hold() is called until the function it gives
// back is, as a harness slow to answer them; refuse(true) has the harness refuse them, at once. sent lists those sent.
async function openGoalWrites(page,{notes=false}={}){
  const writes=notes?/^thread\/continuity\/(set|clear)$/:/^thread\/goal\/(set|clear)$/,sent=[];let gate=null,refusing=false;
  const harness=await openComposerApp(page,{
    refuse:request=>{if(writes.test(request.method))sent.push(request);return refusing&&writes.test(request.method)?(notes?"Continuity store is read-only":"Goal store is read-only"):null},
    hold:request=>writes.test(request.method)?gate?.wait:null,
  });
  return {harness,sent,refuse(value){refusing=value},hold(){let open=()=>{};const wait=new Promise(resolve=>{open=resolve});gate={wait};return()=>{if(gate?.wait===wait)gate=null;open()}}};
}
// What a button pressed says while its write is on its way: what it does, marked busy, and the keyboard still on it. The words are
// soft, so a build that loses the keyboard says that too.
async function pressedWhileHeld(button,doing){
  await expect.soft(button,"the button pressed says what it does while its write is on its way").toHaveText(doing);
  await expect.soft(button,"and is marked busy").toHaveAttribute("aria-busy","true");
  await frames(button.page());await expect(button,"the keyboard stays on the button pressed while its write is on its way").toBeFocused();
}
// The window at 1280 and at 700 wide, the keyboard still on focused, each shot in the mode shown.
async function shootWidths(page,name,focused){
  const mode=await page.locator("html").getAttribute("data-mode");
  for(const width of [1280,700]){await page.setViewportSize({width,height:800});await expect(focused).toBeFocused();await focused.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-"+width+"x800.png"})}
  await page.setViewportSize({width:1280,height:800});
}

// Enter on the Goal panel's Pause, Resume or Complete, reached with Tab, leaves the keyboard in the bar once the goal has changed: on
// Resume, which takes Pause's place, on Pause, which takes Resume's, on Clear, the bar's next control, once Complete goes, and on Set
// goal once Clear goes, with its ring, so the next Tab goes on from there. Each button pressed was disabled while its write was on
// its way, or taken away, and the keyboard fell to the page: no control had it, and none showed a ring.
test("Enter on the Goal panel's Pause, Resume or Complete leaves the keyboard on the button that took its place or on the bar's next control, and the next Tab goes on from there",async({page})=>{
  test.setTimeout(120_000);
  const harness=await openComposerApp(page);
  try{
    const {panel,objective}=await setGoalInPanel(page);
    const bar=panel.locator(":scope>.goal-actions"),button=name=>bar.getByRole("button",{name,exact:true}),status=panel.locator(".goal-status");
    const question=page.locator("dialog.inspector-text-prompt"),ring=locator=>locator.evaluate(node=>node===document.activeElement&&node.matches(":focus-visible"));
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      // The goal is set again from the keyboard once it has been cleared.
      await objective.click();
      if(mode!=="dark"){await page.keyboard.type("Make the login tests pass in "+mode,{delay:15});await tabTo(page,button("Set goal"));await page.keyboard.press("Enter");await expect(status).toHaveText("active")}
      // Tab from Update goal to Pause, and Enter: Resume takes its place, and the keyboard with it; the next Tab goes on to Complete.
      await tabTo(page,button("Update goal"));await page.keyboard.press("Tab");await expect(button("Pause")).toBeFocused();
      await page.keyboard.press("Enter");await expect(status).toHaveText("paused");await frames(page);
      await expect(button("Resume"),"Resume took Pause's place, and the keyboard is on it").toBeFocused();expect(await ring(button("Resume")),"with its ring").toBe(true);
      await page.keyboard.press("Tab");await expect(button("Complete")).toBeFocused();await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Enter");await expect(status).toHaveText("active");await frames(page);
      await expect(button("Pause"),"Pause took Resume's place, and the keyboard is on it").toBeFocused();
      // Complete takes Pause and itself away: the keyboard goes on to Clear.
      await page.keyboard.press("Tab");await expect(button("Complete")).toBeFocused();
      await page.keyboard.press("Enter");await expect(status).toHaveText("complete");await frames(page);
      await expect(button("Clear"),"once Complete goes the keyboard is on Clear, the bar's next control").toBeFocused();expect(await ring(button("Clear")),"with its ring").toBe(true);
      await shootWidths(page,"goal-complete-by-enter-keyboard-on-clear",button("Clear"));
      // Clear, confirmed from the keyboard, takes itself away: the keyboard goes back to Set goal.
      await page.keyboard.press("Enter");await expect(question.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
      await page.keyboard.press("Tab");await page.keyboard.press("Enter");await expect(question).toHaveCount(0);
      await expect(status).toHaveText("not set");await frames(page);
      await expect(button("Set goal"),"once Clear goes the keyboard is on Set goal, the control before it").toBeFocused();expect(await ring(button("Set goal")),"with its ring").toBe(true);
    }
  }finally{await harness.close()}
});

// A goal write the harness takes its time over says what it does on the button pressed (Update goal reads Saving…, Pause Pausing…),
// marked busy, and the keyboard stays in the Goal bar meanwhile and once it lands: on the button pressed, on the one that took its
// place (Resume where Pause was, Pause where Resume was), or on the bar's next control (Clear once Complete goes, Set goal once Clear
// goes), also when the harness refuses it. Every button there was disabled for the wait, only greyed, with nothing saying what ran,
// which took the keyboard to the page: after Pause, Resume, Complete or Update goal no control had it.
test("a goal write the harness is slow to answer says so on the button pressed, and the keyboard stays in the Goal bar: on Update goal, on Resume where Pause was and Pause where Resume was, on Clear once Complete goes, on Set goal once the goal is cleared, and on Set goal when the save is refused",async({page})=>{
  test.setTimeout(150_000);
  const writes=await openGoalWrites(page);
  try{
    const {panel,objective}=await setGoalInPanel(page);
    const bar=panel.locator(":scope>.goal-actions"),button=name=>bar.getByRole("button",{name,exact:true}),status=panel.locator(".goal-status"),save=bar.locator("button.primary");
    const question=page.locator("dialog.inspector-text-prompt"),statuses=()=>writes.sent.filter(request=>request.method==="thread/goal/set").map(request=>request.params.status),sets=()=>statuses().length;
    // An edit saved from the keyboard, in each mode: Tab from the Objective to Update goal and Enter, the harness slow to answer.
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      await typeOver(page,objective,"Make the login and signup tests pass in "+mode);
      await tabTo(page,save);
      const release=writes.hold(),before=sets();await page.keyboard.press("Enter");
      await pressedWhileHeld(save,"Saving…");
      await expect(button("Discard changes"),"the bar's other buttons wait meanwhile").toBeDisabled();await expect(button("Clear")).toBeDisabled();
      // A second Enter while the save is on its way sends nothing more.
      await page.keyboard.press("Enter");
      await shootWidths(page,"goal-save-held-keyboard",save);
      release();
      await expect(save).toHaveText("Update goal");await expect(save).not.toHaveAttribute("aria-busy");
      await expect(save,"the keyboard is on Update goal once the save lands").toBeFocused();
      await expect(objective).toHaveValue("Make the login and signup tests pass in "+mode);
      expect(sets(),"one save for the two presses").toBe(before+1);
    }
    // With the mouse: Pause reads Pausing… while it is on its way, a click on Complete meanwhile does nothing, and Resume comes.
    let release=writes.hold();await button("Pause").click();
    await expect(button("Pausing…")).toHaveAttribute("aria-busy","true");await expect(button("Complete")).toBeDisabled();
    const complete=await button("Complete").boundingBox();await page.mouse.click(complete.x+complete.width/2,complete.y+complete.height/2);
    release();await expect(status).toHaveText("paused");
    await button("Resume").click();await expect(status).toHaveText("active");
    expect(statuses().slice(-2),"the click on Complete while Pause was on its way sent nothing").toEqual(["paused","active"]);
    // Pause from the keyboard: Resume takes its place and the keyboard with it, and Pause takes Resume's.
    await page.keyboard.press("Shift+Tab");await expect(save).toBeFocused();await page.keyboard.press("Tab");await expect(button("Pause")).toBeFocused();
    release=writes.hold();await page.keyboard.press("Enter");
    await pressedWhileHeld(button("Pausing…"),"Pausing…");
    release();await expect(status).toHaveText("paused");
    await expect(button("Resume"),"Resume took Pause's place, and the keyboard is on it").toBeFocused();
    release=writes.hold();await page.keyboard.press("Enter");
    await pressedWhileHeld(button("Resuming…"),"Resuming…");
    release();await expect(status).toHaveText("active");
    await expect(button("Pause"),"Pause took Resume's place, and the keyboard is on it").toBeFocused();
    // Complete takes Pause and itself away: the keyboard goes on to Clear, the bar's next control, with its ring.
    await page.keyboard.press("Tab");await expect(button("Complete")).toBeFocused();
    release=writes.hold();await page.keyboard.press("Enter");
    await pressedWhileHeld(button("Completing…"),"Completing…");
    release();await expect(status).toHaveText("complete");await expect(bar.getByRole("button")).toHaveText(["Update goal","Clear"]);
    await expect(button("Clear"),"once Complete goes the keyboard is on Clear, the bar's next control").toBeFocused();
    expect(await button("Clear").evaluate(node=>node.matches(":focus-visible")),"with its ring").toBe(true);
    await shootWidths(page,"goal-complete-keyboard-on-clear",button("Clear"));
    // Clear, confirmed from the keyboard: Set goal is what is left, and the keyboard is on it.
    await page.keyboard.press("Enter");await expect(question.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
    await page.keyboard.press("Tab");await expect(question.getByRole("button",{name:"Clear goal",exact:true})).toBeFocused();
    release=writes.hold();await page.keyboard.press("Enter");await expect(question).toHaveCount(0);
    await pressedWhileHeld(button("Clearing…"),"Clearing…");
    release();await expect(status).toHaveText("not set");
    await expect(button("Set goal"),"once Clear goes the keyboard is on Set goal, the control before it").toBeFocused();
    // A save the harness refuses says why above the bar, and the keyboard stays on Set goal.
    await objective.click();await page.keyboard.type("Make the checkout tests pass",{delay:15});
    await tabTo(page,save);
    writes.refuse(true);await page.keyboard.press("Enter");
    await expect(bar.getByRole("alert")).toContainText("Goal store is read-only");
    await expect(save).toHaveText("Set goal");await expect(save,"the keyboard stays on Set goal when the save is refused").toBeFocused();
    await expect(objective).toHaveValue("Make the checkout tests pass");
    await shootWidths(page,"goal-save-refused-keyboard",save);
  }finally{await writes.harness.close()}
});

// The same for the notes: Save continuity reads Saving… while the harness takes its time, and the keyboard stays on it; Discard
// changes, once the edit is discarded and it goes, hands the keyboard to Clear notes, and Clear notes, once the notes are cleared
// and it goes, to Save continuity; a refused save leaves it on Save continuity too. Save continuity was disabled for the wait, which
// took the keyboard to the page.
test("a continuity save the harness is slow to answer says Saving… on Save continuity and the keyboard stays on it, Clear notes hands the keyboard to Save continuity once the notes are cleared, and a refused save keeps it there",async({page})=>{
  test.setTimeout(120_000);
  const writes=await openGoalWrites(page,{notes:true});
  try{
    await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    const panel=page.getByTestId("goal-panel"),row=panel.locator(".continuity-actions"),save=row.locator("button.primary"),done=panel.getByLabel("Completed work",{exact:true});
    const summary=panel.locator(".goal-continuity-details>summary"),question=page.locator("dialog.inspector-text-prompt"),clearNotes=row.locator("button.danger");
    await panel.getByText("Continuity state",{exact:true}).click();
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      await typeOver(page,done,"Fixed the session refresh in "+mode);
      await tabTo(page,save);
      const release=writes.hold(),before=writes.sent.length;await page.keyboard.press("Enter");
      await pressedWhileHeld(save,"Saving…");
      await page.keyboard.press("Enter");
      await shootWidths(page,"goal-notes-save-held-keyboard",save);
      release();
      await expect(summary).toContainText("1 explicit note");await expect(done).toHaveValue("Fixed the session refresh in "+mode);
      await expect(save).toHaveText("Save continuity");await expect(save,"the keyboard is on Save continuity once the notes are saved").toBeFocused();
      expect(writes.sent.length,"one save for the two presses").toBe(before+1);
    }
    // An edit discarded from the keyboard: Discard changes goes, and the keyboard goes on to Clear notes, the bar's next control.
    await done.click();await page.keyboard.press("End");await page.keyboard.type(" and its rollback",{delay:15});
    const discard=row.getByRole("button",{name:"Discard changes",exact:true});await tabTo(page,discard);
    await page.keyboard.press("Enter");await expect(question.getByRole("button",{name:"Keep editing",exact:true})).toBeFocused();
    await page.keyboard.press("Tab");await page.keyboard.press("Enter");await expect(question).toHaveCount(0);
    await expect(done).toHaveValue("Fixed the session refresh in light");await expect(discard).toHaveCount(0);
    await expect(clearNotes,"once Discard changes goes the keyboard is on Clear notes, the bar's next control").toBeFocused();
    // Clear notes from the keyboard, confirmed: it goes with the notes, and the keyboard goes back to Save continuity.
    await page.keyboard.press("Enter");await expect(question.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
    await page.keyboard.press("Tab");const release=writes.hold();await page.keyboard.press("Enter");await expect(question).toHaveCount(0);
    await pressedWhileHeld(clearNotes,"Clearing…");
    release();await expect(clearNotes).toHaveCount(0);await expect(done).toHaveValue("");
    await expect(save,"once Clear notes goes the keyboard is on Save continuity").toBeFocused();
    // A save the harness refuses says why above Save continuity, and the keyboard stays on it.
    await done.click();await page.keyboard.type("Moved the form to the new API",{delay:15});
    await tabTo(page,save);
    writes.refuse(true);await page.keyboard.press("Enter");
    await expect(row.getByRole("alert")).toContainText("Continuity store is read-only");
    await expect(save,"the keyboard stays on Save continuity when the save is refused").toBeFocused();await expect(done).toHaveValue("Moved the form to the new API");
  }finally{await writes.harness.close()}
});

// A Goal panel drawn again while its save is on its way (back from Files, with the right panel closed and opened again, or back from
// another thread) says so as the panel that sent it did: Update goal or Save continuity reads Saving… (Pause Pausing…), marked busy,
// with the bars' other buttons off, a second press sends nothing until the save lands, and a refusal is said above the bar as it
// lands. The save went with the panel that sent it, so the one drawn again offered Update goal or Save continuity, Discard changes,
// Pause, Complete and Clear, a second press saved again, and a refusal was said nowhere.
test("a Goal panel drawn again while its save is on its way, back from Files, with the right panel closed and opened again or back from another thread, says Saving… with the other buttons off, takes no second press until the save lands, and says a refusal",async({page})=>{
  test.setTimeout(180_000);
  const socket=await relaySocket(page);
  const harness=await openComposerApp(page,{others:["Second thread"]});
  try{
    const {panel,objective}=await setGoalInPanel(page);
    const bar=panel.locator(":scope>.goal-actions"),save=bar.locator("button.primary"),button=name=>bar.getByRole("button",{name,exact:true});
    const tabs=page.getByTestId("right-panel").locator(".context-panel-tab-scroll"),composer=page.getByTestId("composer");
    const openThread=async name=>{const row=threadRow(page,name);await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);await expect(composer).not.toHaveAttribute("placeholder","Opening thread…");await painted(page)};
    // The ways a person takes the panel away and draws it again.
    const ways={
      "back from Files":async()=>{await tabs.getByRole("button",{name:"Files",exact:true}).click();await expect(panel).toHaveCount(0);await tabs.getByRole("button",{name:"Goal",exact:true}).click()},
      "with the right panel closed and opened again":async()=>{await page.getByRole("button",{name:"Close right panel"}).click();await expect(panel).toHaveCount(0);await page.getByRole("button",{name:"Thread goal",exact:true}).click()},
      "back from another thread":async()=>{await openThread("Second thread");await expect(save).toHaveText("Set goal");await openThread("Composer thread")},
    };
    // A second press as a person makes it on a button that says it is off: a click on it, then Enter.
    const pressAgain=async target=>{await target.evaluate(node=>node.scrollIntoView({block:"center"}));const box=await target.boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await page.keyboard.press("Enter");await painted(page)};
    const shoot=async(name,shown)=>{
      const mode=await page.locator("html").getAttribute("data-mode");
      for(const width of [1280,700]){await page.setViewportSize({width,height:800});await shown.evaluate(node=>node.scrollIntoView({block:"center"}));await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-"+width+"x800.png"})}
      await page.setViewportSize({width:1280,height:800});
    };
    const sets=()=>socket.sent("thread/goal/set").length;
    for(const [index,[way,away]] of Object.entries(ways).entries()){
      await switchMode(page,index===1?"light":"dark");
      const text="Make the login tests pass, "+way;await typeOver(page,objective,text);
      socket.hold("thread/goal/set");const before=sets();await save.click();await expect(save).toHaveText("Saving…");
      await away();await expect(objective,"the edit is kept "+way).toHaveValue(text);await painted(page);
      // Soft, so a build that loses the save says so for each way.
      await expect.soft(save,"the panel drawn again "+way+" says the save is on its way").toHaveText("Saving…");
      await expect.soft(save,"marked busy "+way).toHaveAttribute("aria-busy","true");
      for(const name of ["Discard changes","Pause","Complete","Clear"])await expect.soft(button(name),name+" is off "+way).toHaveAttribute("aria-disabled","true");
      if(index<2)await shoot("goal-drawn-again-save-held",save);
      await pressAgain(save);
      expect.soft(sets(),"a second press "+way+" sends nothing while the save is on its way").toBe(before+1);
      socket.release();
      await expect(save).toHaveText("Update goal");await expect(save).not.toHaveAttribute("aria-busy");
      await expect(button("Discard changes"),"nothing is left unsaved once the save lands").toHaveCount(0);await expect(objective).toHaveValue(text);
    }
    // So does Pause: back from Files it reads Pausing…, marked busy, and once it lands Resume takes its place.
    const status=panel.locator(".goal-status");
    socket.hold("thread/goal/set");await button("Pause").click();await expect(button("Pausing…")).toHaveAttribute("aria-busy","true");
    await ways["back from Files"]();await expect(status).toHaveText("active");
    await expect.soft(button("Pausing…"),"Pause drawn again says the goal is being paused").toHaveAttribute("aria-busy","true");
    await expect.soft(save,"with the bar's other buttons off").toHaveAttribute("aria-disabled","true");
    socket.release();await expect(status).toHaveText("paused");await expect(button("Resume")).not.toHaveAttribute("aria-disabled");
    await button("Resume").click();await expect(status).toHaveText("active");
    // The notes the same way: back from Files the panel draws Continuity state open, with Save continuity reading Saving… in sight
    // and the bars' other buttons off, a second press sends nothing, and once the save lands the note is saved. The section was drawn
    // closed, so nothing in sight said why the goal's bar was off.
    const notes=panel.locator(".continuity-actions"),saveNotes=notes.locator("button.primary"),done=panel.getByLabel("Completed work",{exact:true});
    const summary=panel.locator(".goal-continuity-details>summary"),showNotes=()=>panel.getByText("Continuity state",{exact:true}).click();
    await showNotes();await typeOver(page,done,"Fixed the session refresh");
    socket.hold("thread/continuity/set");const notesBefore=socket.sent("thread/continuity/set").length;
    await saveNotes.click();await expect(saveNotes).toHaveText("Saving…");
    await ways["back from Files"]();
    await expect.soft(saveNotes,"the panel drawn again draws Continuity state open, its save on its way in sight").toBeVisible();
    // A build that draws it closed: the person opens it to go on.
    if(!await saveNotes.isVisible())await showNotes();
    await expect(done).toHaveValue("Fixed the session refresh");
    await expect.soft(saveNotes,"the notes drawn again say their save is on its way").toHaveText("Saving…");
    await expect.soft(saveNotes,"marked busy").toHaveAttribute("aria-busy","true");
    await expect.soft(notes.getByRole("button",{name:"Discard changes",exact:true}),"the notes' Discard changes is off").toHaveAttribute("aria-disabled","true");
    await expect.soft(save,"and so is the goal's bar").toHaveAttribute("aria-disabled","true");
    await shoot("goal-notes-drawn-again-save-held",saveNotes);
    await pressAgain(saveNotes);
    expect.soft(socket.sent("thread/continuity/set").length,"a second Save continuity sends nothing while the save is on its way").toBe(notesBefore+1);
    socket.release();
    await expect(summary).toContainText("1 explicit note");await expect(saveNotes).toHaveText("Save continuity");
    await expect(notes.getByRole("button",{name:"Discard changes",exact:true})).toHaveCount(0);await expect(done).toHaveValue("Fixed the session refresh");
    // A save refused once the panel is drawn again is said above its bar, as to a panel that stays, and the edit stays to save again.
    await switchMode(page,"light");
    await typeOver(page,objective,"Make the checkout tests pass");socket.hold("thread/goal/set");await save.click();await expect(save).toHaveText("Saving…");
    await ways["back from Files"]();await expect.soft(save,"the panel drawn again says the save is on its way").toHaveText("Saving…");
    socket.release("Goal store is read-only");
    await expect(bar.getByRole("alert"),"the refusal is said above the bar of the panel drawn again").toContainText("Goal store is read-only");
    await expect(save).toHaveText("Update goal");await expect(objective).toHaveValue("Make the checkout tests pass");await expect(button("Discard changes")).toBeVisible();
    await shoot("goal-drawn-again-save-refused",bar.getByRole("alert"));
    // A notes save refused once the panel is drawn again (with the right panel closed and opened again): Continuity state is drawn
    // open with Saving… in sight, the refusal is said above Save continuity, in view, and the note stays to save again. So it is when
    // the person closed the section meanwhile: the refusal opens it. The refusal was drawn in the closed section, out of sight, while
    // the bars came back live.
    const refusal=notes.getByRole("alert");
    if(!await saveNotes.isVisible())await showNotes();
    await typeOver(page,done,"Moved the form to the new API");
    socket.hold("thread/continuity/set");await saveNotes.click();await expect(saveNotes).toHaveText("Saving…");
    await ways["with the right panel closed and opened again"]();
    await expect.soft(saveNotes,"the panel drawn again shows the notes' save on its way").toBeVisible();
    socket.release("Continuity store is read-only");
    await expect(refusal,"the notes' refusal is said in sight on the panel drawn again").toBeVisible();
    await expect(refusal).toContainText("Continuity store is read-only");await expect(refusal).toBeInViewport();
    await expect(done).toHaveValue("Moved the form to the new API");await expect(notes.getByRole("button",{name:"Discard changes",exact:true})).toBeVisible();
    await expect(save,"the goal's bar is live again").not.toHaveAttribute("aria-disabled");
    await shoot("goal-notes-drawn-again-save-refused",refusal);
    socket.hold("thread/continuity/set");await saveNotes.click();await expect(saveNotes).toHaveText("Saving…");
    await ways["back from Files"]();
    if(await saveNotes.isVisible())await summary.click();
    await expect(saveNotes,"the person has closed Continuity state").toBeHidden();
    socket.release("Continuity store is read-only");
    await expect(refusal,"a refusal opens the section the person closed, and is said in sight").toBeVisible();await expect(refusal).toBeInViewport();
    // A refusal that lands while no Goal panel is drawn (the person is on Files) is said once the panel is drawn again, above its bar;
    // it was said nowhere.
    await typeOver(page,objective,"Make the payment tests pass");
    socket.hold("thread/goal/set");await save.click();await expect(save).toHaveText("Saving…");
    await tabs.getByRole("button",{name:"Files",exact:true}).click();await expect(panel).toHaveCount(0);
    socket.release("Goal store is locked for the release");await page.waitForTimeout(600);await painted(page);
    await tabs.getByRole("button",{name:"Goal",exact:true}).click();
    await expect(bar.getByRole("alert"),"a refusal that landed while no panel was drawn is said once it is drawn again").toHaveText("Goal store is locked for the release");
    await expect(bar.getByRole("alert")).toBeInViewport();
    await expect(save).toHaveText("Update goal");await expect(objective).toHaveValue("Make the payment tests pass");await expect(button("Discard changes")).toBeVisible();
    await shoot("goal-refused-while-away",bar.getByRole("alert"));
  }finally{await harness.close()}
});

// The Goal panel's clears (the goal's and the notes'), each held from when hold() is called until the function it gives back is, as
// a harness slow to answer them; with hold("answer") only the answer waits, once the harness has said the clear is done.
async function openSlowClears(page){
  const gates={request:null,answer:null},clears=request=>/^thread\/(goal|continuity)\/clear$/.test(request.method);
  const harness=await openComposerApp(page,{hold:request=>clears(request)?gates.request:null,answer:request=>clears(request)?gates.answer:null});
  return {harness,hold(what="request"){let open=()=>{};gates[what]=new Promise(resolve=>{open=resolve});return()=>{gates[what]=null;open()}}};
}
// Enter on row's button name, reached with Tab, then Tab from Cancel to the question's confirm button and Enter; meanwhile() runs once
// the question has gone, while a clear held is on its way.
async function clearFromKeyboard(page,row,name,meanwhile=async()=>{}){
  const question=page.locator("dialog.inspector-text-prompt");
  await tabTo(page,row.getByRole("button",{name,exact:true}));
  await page.keyboard.press("Enter");await expect(question.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
  await page.keyboard.press("Tab");await page.keyboard.press("Enter");await expect(question).toHaveCount(0);
  await meanwhile();
}
const ringed=locator=>locator.evaluate(node=>node===document.activeElement&&node.matches(":focus-visible"));
// Each clear below is answered at once, slowly (the button pressed says Clearing… meanwhile), or said done before its answer comes,
// when what was cleared already shows and its answer is still on its way.
const CLEAR_ANSWERS=[{mode:"dark"},{mode:"light",slow:"request"},{mode:"dark",slow:"answer"}];
async function whileClearHeld(page,row,slow,release,cleared){
  if(slow==="request")await pressedWhileHeld(row.getByRole("button",{name:"Clearing…",exact:true}),"Clearing…");
  if(slow==="answer"){await cleared();await painted(page);await painted(page)}
  release?.();
}
// Counts each note of a change made elsewhere the page draws from now on, however briefly; the function it gives back stops
// counting and reads the count.
async function countChangedNotes(page){
  await page.evaluate(()=>{
    const seen={count:0};window.changedNotesSeen=seen;
    seen.observer=new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1&&(node.matches(".goal-field-changed")||node.querySelector(".goal-field-changed")))seen.count++});
    seen.observer.observe(document.body,{childList:true,subtree:true});
  });
  return ()=>page.evaluate(()=>{const seen=window.changedNotesSeen;seen.observer.disconnect();return seen.count});
}

// Clear pressed from the keyboard with an edit to the Objective left unsaved: the edit goes with the goal cleared, and Discard
// changes with it, so once the clear lands the keyboard is on Set goal. It was handed on to Discard changes, which went a moment
// later and took the keyboard to the page; and an Objective cleared while its answer came was said to have been cleared elsewhere.
test("Clear pressed from the keyboard with an Objective edit unsaved leaves the keyboard on Set goal once the goal is cleared, with no Discard changes or change said made elsewhere left",async({page})=>{
  test.setTimeout(150_000);
  const clears=await openSlowClears(page);
  try{
    const {panel,objective}=await setGoalInPanel(page);
    const bar=panel.locator(":scope>.goal-actions"),status=panel.locator(".goal-status"),save=bar.locator("button.primary");
    for(const [index,{mode,slow}] of CLEAR_ANSWERS.entries()){
      await switchMode(page,mode);
      if(index){await objective.click();await page.keyboard.type("Make the login tests pass",{delay:15});await save.click();await expect(status).toHaveText("active")}
      // An edit to the Objective, left unsaved, so Discard changes is offered beside Update goal.
      await typeOver(page,objective,"Make the login and signup tests pass in "+mode);await expect(bar.getByRole("button",{name:"Discard changes",exact:true})).toBeVisible();
      const release=slow?clears.hold(slow):null,changedNotesSeen=await countChangedNotes(page);
      await clearFromKeyboard(page,bar,"Clear",()=>whileClearHeld(page,bar,slow,release,()=>expect(status).toHaveText("not set")));
      await expect(status).toHaveText("not set");await expect(objective).toHaveValue("");
      await expect.soft(bar.getByRole("button"),"the edit went with the goal: no Discard changes, and no change said made elsewhere").toHaveText(["Set goal"]);
      expect.soft(await changedNotesSeen(),"the goal this panel cleared is never said to have changed elsewhere ("+(slow||"at once")+")").toBe(0);
      // Soft, so a build that loses the keyboard says so for each way the clear is answered.
      await frames(page);await expect.soft(save,"once Clear goes the keyboard is on Set goal, not on the Discard changes that goes with the edit ("+(slow||"at once")+")").toBeFocused();
      expect.soft(await ringed(save),"with its ring").toBe(true);
      if(slow!=="answer"&&await ringed(save))await shootWidths(page,"goal-clear-unsaved-keyboard-on-set-goal",save);
    }
  }finally{await clears.harness.close()}
});

// The same for Clear notes with a note saved, then edited and left unsaved: once the notes are cleared the keyboard is on Save
// continuity.
test("Clear notes pressed from the keyboard with a note edit unsaved leaves the keyboard on Save continuity once the notes are cleared, with no Discard changes or change said made elsewhere left",async({page})=>{
  test.setTimeout(150_000);
  const clears=await openSlowClears(page);
  try{
    await page.getByRole("button",{name:"Thread goal",exact:true}).click();
    const panel=page.getByTestId("goal-panel"),row=panel.locator(".continuity-actions"),save=row.locator("button.primary"),done=panel.getByLabel("Completed work",{exact:true});
    const summary=panel.locator(".goal-continuity-details>summary");
    await panel.getByText("Continuity state",{exact:true}).click();
    for(const {mode,slow} of CLEAR_ANSWERS){
      await switchMode(page,mode);
      // A note saved, then edited and left unsaved, so Discard changes is offered beside Save continuity.
      await typeOver(page,done,"Fixed the session refresh in "+mode);await save.click();await expect(summary).toContainText("1 explicit note");
      await done.click();await page.keyboard.press("End");await page.keyboard.type(" and its rollback",{delay:15});
      await expect(row.getByRole("button",{name:"Discard changes",exact:true})).toBeVisible();
      const release=slow?clears.hold(slow):null,changedNotesSeen=await countChangedNotes(page);
      await clearFromKeyboard(page,row,"Clear notes",()=>whileClearHeld(page,row,slow,release,()=>expect(summary).toContainText("Derived facts only")));
      await expect(summary).toContainText("Derived facts only");await expect(done).toHaveValue("");
      await expect.soft(row.getByRole("button"),"the edit went with the notes: no Discard changes, and no change said made elsewhere").toHaveText(["Save continuity"]);
      expect.soft(await changedNotesSeen(),"the notes this panel cleared are never said to have changed elsewhere ("+(slow||"at once")+")").toBe(0);
      await frames(page);await expect.soft(save,"once Clear notes goes the keyboard is on Save continuity, not on the Discard changes that goes with the edit ("+(slow||"at once")+")").toBeFocused();
      expect.soft(await ringed(save),"with its ring").toBe(true);
      if(slow!=="answer"&&await ringed(save))await shootWidths(page,"goal-notes-clear-unsaved-keyboard-on-save",save);
    }
  }finally{await clears.harness.close()}
});

// The page's side of the harness's socket, for a clear whose answer comes in the moment the page has drawn what the harness said
// ahead of it. Once until(selector) is called, the next clear sent (the goal's or the notes') has what comes after it held until its
// answer comes, and then given to the page at once, while the answer waits until the page has drawn that (nothing matches selector
// any more) and comes in that moment, before React runs what follows the drawing (its effects). given() counts the answers so given.
async function lateClearAnswers(page){
  await page.addInitScript(()=>{
    const Native=window.WebSocket,late=window.lateClearAnswer={selector:null,awaited:null,held:[],answer:null,given:0};
    new MutationObserver(()=>{if(late.answer&&!document.querySelector(late.selector)){const give=late.answer;Object.assign(late,{answer:null,selector:null,given:late.given+1});give()}}).observe(document,{subtree:true,childList:true,characterData:true});
    window.WebSocket=class extends Native{
      constructor(...args){
        super(...args);
        this.addEventListener("message",event=>{
          if(!event.isTrusted||late.awaited?.socket!==this)return;
          event.stopImmediatePropagation();
          let message=null;try{message=JSON.parse(event.data)}catch{}
          const give=()=>this.dispatchEvent(new MessageEvent("message",{data:event.data}));
          if(message?.method||message?.id!==late.awaited.id){late.held.push(give);return}
          late.awaited=null;for(const before of late.held.splice(0))before();late.answer=give;
        });
      }
      send(data){
        let message=null;try{message=JSON.parse(data)}catch{}
        if(late.selector&&!late.awaited&&!late.answer&&/^thread\/(goal|continuity)\/clear$/.test(message?.method||""))late.awaited={socket:this,id:message.id};
        return super.send(data);
      }
    };
  });
  return {until:selector=>page.evaluate(selector=>{window.lateClearAnswer.selector=selector},selector),given:()=>page.evaluate(()=>window.lateClearAnswer.given)};
}

// Clear, then Clear notes, pressed from the keyboard with an edit left unsaved, whose answer comes in the moment the panel has drawn
// the clear the harness said ahead of it (the goal cleared, the notes cleared), before React has run what follows that drawing: the
// fields are left empty, with no Discard changes or change said made elsewhere, and the keyboard goes on to Set goal, then to Save
// continuity. The fields as drawn before the answer were taken for edits and put back, the goal's saved Objective too, so a clear
// left them filled with Discard changes on, and the keyboard there or on the page.
test("a clear whose answer comes in the moment the panel has drawn the clear the harness said ahead of it leaves the fields empty, with no Discard changes or change said made elsewhere, and the keyboard on Set goal or Save continuity",async({page})=>{
  test.setTimeout(150_000);
  const late=await lateClearAnswers(page);
  const harness=await openComposerApp(page);
  try{
    const {panel,objective}=await setGoalInPanel(page);
    const bar=panel.locator(":scope>.goal-actions"),status=panel.locator(".goal-status"),setGoal=bar.locator("button.primary");
    const row=panel.locator(".continuity-actions"),saveNotes=row.locator("button.primary"),done=panel.getByLabel("Completed work",{exact:true});
    const summary=panel.locator(".goal-continuity-details>summary"),continuity=panel.getByText("Continuity state",{exact:true});
    for(const [index,mode] of ["dark","light"].entries()){
      await switchMode(page,mode);
      if(index){await objective.click();await page.keyboard.type("Make the login tests pass",{delay:15});await setGoal.click();await expect(status).toHaveText("active")}
      // The goal's Clear, with an edit to the Objective left unsaved.
      await typeOver(page,objective,"Make the login and signup tests pass in "+mode);await expect(bar.getByRole("button",{name:"Discard changes",exact:true})).toBeVisible();
      let changedNotesSeen=await countChangedNotes(page);await late.until('[data-testid="goal-panel"]>.goal-actions button.danger');
      await clearFromKeyboard(page,bar,"Clear");
      await expect(status).toHaveText("not set");await expect.poll(late.given,"the clear's answer came once the goal cleared was drawn").toBe(2*index+1);
      await frames(page);
      // Soft, so a build that puts the fields back says what else it does.
      await expect.soft(objective,"the Objective's edit went with the goal").toHaveValue("");
      await expect.soft(bar.getByRole("button"),"no Discard changes, and no change said made elsewhere").toHaveText(["Set goal"]);
      expect.soft(await changedNotesSeen(),"the goal this panel cleared is never said to have changed elsewhere").toBe(0);
      await expect.soft(setGoal,"once Clear goes the keyboard is on Set goal").toBeFocused();expect.soft(await ringed(setGoal),"with its ring").toBe(true);
      if(await ringed(setGoal))await shootWidths(page,"goal-clear-answer-after-drawn-keyboard-on-set-goal",setGoal);
      // The notes' Clear notes, with a note saved, then edited and left unsaved.
      await continuity.click();
      await typeOver(page,done,"Fixed the session refresh in "+mode);await saveNotes.click();await expect(summary).toContainText("1 explicit note");
      await done.click();await page.keyboard.press("End");await page.keyboard.type(" and its rollback",{delay:15});
      await expect(row.getByRole("button",{name:"Discard changes",exact:true})).toBeVisible();
      changedNotesSeen=await countChangedNotes(page);await late.until('[data-testid="goal-panel"] .continuity-actions button.danger');
      await clearFromKeyboard(page,row,"Clear notes");
      await expect(summary).toContainText("Derived facts only");await expect.poll(late.given,"the clear's answer came once the notes cleared were drawn").toBe(2*index+2);
      await frames(page);
      await expect.soft(done,"the note's edit went with the notes").toHaveValue("");
      await expect.soft(row.getByRole("button"),"no Discard changes, and no change said made elsewhere").toHaveText(["Save continuity"]);
      expect.soft(await changedNotesSeen(),"the notes this panel cleared are never said to have changed elsewhere").toBe(0);
      await expect.soft(saveNotes,"once Clear notes goes the keyboard is on Save continuity").toBeFocused();expect.soft(await ringed(saveNotes),"with its ring").toBe(true);
      if(await ringed(saveNotes))await shootWidths(page,"goal-notes-clear-answer-after-drawn-keyboard-on-save",saveNotes);
      await continuity.click();
    }
  }finally{await harness.close()}
});

// The Goal panel opened with its goal set (setGoalInPanel) over openGoalWrites' harness, for a keyboard press in its bar and then
// a click on the transcript's text, which leaves the keyboard on the page. keyboardOn names what has the keyboard (the page, or a
// control by its words); statusElsewhere sets the goal's status from another window, as Codex ends a goal itself; leftOnPage
// expects the keyboard still on the page, and Space then to ask nothing (softly, closing a question asked, so a build that moves
// the keyboard says so for each mode).
async function goalBar(page,writes){
  const {panel,objective}=await setGoalInPanel(page);
  const bar=panel.locator(":scope>.goal-actions"),status=panel.locator(".goal-status"),question=page.locator("dialog.inspector-text-prompt");
  const keyboardOn=()=>page.evaluate(()=>document.activeElement===document.body?"the page":String(document.activeElement?.textContent||document.activeElement?.tagName).trim());
  return {objective,bar,status,button:name=>bar.getByRole("button",{name,exact:true}),
    async statusElsewhere(value){await relayRequest(writes.harness,"thread/goal/set",{threadId:writes.harness.threads[0].id,status:value});await expect(status).toHaveText(value);await painted(page)},
    async clickTranscript(){await page.getByText("The login page renders.",{exact:true}).click();expect(await keyboardOn(),"a click on the transcript's text leaves the keyboard on the page").toBe("the page")},
    async leftOnPage(why){
      expect.soft(await keyboardOn(),why).toBe("the page");await page.keyboard.press("Space");await painted(page);
      const asked=await question.count();if(asked){await page.keyboard.press("Escape");await expect(question).toHaveCount(0)}
      expect.soft(asked,"Space asks nothing").toBe(0);
    },
  };
}

// Enter on Pause, then a click on the transcript's text: when Codex ends the goal later (here from another window), Resume and
// Complete go and the keyboard stays on the page, so Space asks nothing. The press was kept until the next one, and the keyboard was
// put on Clear with nothing pressed, where Space asked to clear the goal.
test("Enter on the Goal panel's Pause and then a click on the transcript: when the goal ends later the keyboard stays where the person put it, and Space then asks nothing",async({page})=>{
  test.setTimeout(120_000);
  const writes=await openGoalWrites(page);
  try{
    const goal=await goalBar(page,writes);
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      if(mode!=="dark")await goal.statusElsewhere("active");
      // Enter on Pause, reached with Tab: Resume takes its place with the keyboard.
      await goal.objective.click();await tabTo(page,goal.button("Pause"));
      await page.keyboard.press("Enter");await expect(goal.status).toHaveText("paused");await expect(goal.button("Resume")).toBeFocused();
      await goal.clickTranscript();
      await goal.statusElsewhere("complete");await expect(goal.bar.getByRole("button")).toHaveText(["Update goal","Clear"]);
      await goal.leftOnPage("once Resume and Complete go, the keyboard stays where the person put it, never on Clear");
      await page.screenshot({animations:"disabled",path:auditDir+"goal-ended-after-click-keyboard-left-"+mode+"-1280x800.png"});
    }
  }finally{await writes.harness.close()}
});

// Enter on Complete, its write slow, and a click on the transcript's text while it is on its way: once it lands Complete goes and
// the keyboard stays on the page, where the old press put it on Clear. Without the click it goes on to Clear, as before.
test("Enter on the Goal panel's Complete, slow to land, and a click on the transcript meanwhile: once it lands the keyboard stays where the person put it, and without the click it goes on to Clear",async({page})=>{
  test.setTimeout(120_000);
  const writes=await openGoalWrites(page);
  try{
    const goal=await goalBar(page,writes);
    const completeFromKeyboard=async()=>{
      await goal.objective.click();await tabTo(page,goal.button("Complete"));
      const release=writes.hold();await page.keyboard.press("Enter");await pressedWhileHeld(goal.button("Completing…"),"Completing…");
      return release;
    };
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      if(mode!=="dark")await goal.statusElsewhere("active");
      const release=await completeFromKeyboard();
      await goal.clickTranscript();
      release();await expect(goal.status).toHaveText("complete");await expect(goal.bar.getByRole("button")).toHaveText(["Update goal","Clear"]);await painted(page);
      await goal.leftOnPage("once a slow Complete lands after the click, the keyboard stays where the person put it, never on Clear");
      await page.screenshot({animations:"disabled",path:auditDir+"goal-complete-landed-after-click-keyboard-left-"+mode+"-1280x800.png"});
    }
    await goal.statusElsewhere("active");
    const release=await completeFromKeyboard();release();await expect(goal.status).toHaveText("complete");
    await expect(goal.button("Clear"),"once Complete goes with the keyboard still on it, the keyboard is on Clear, the bar's next control").toBeFocused();
  }finally{await writes.harness.close()}
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

// What a person sees of each chip in the shelf's view (and of the one whose remove button has focus), by its name: the name "whole",
// "cut with an ellipsis" or "cut with no ellipsis"; the remove button "at the chip's end" when it lies whole inside the chip at its
// right end and the page answers it at its middle, or else how far past the chip's end it lies or what the page answers there; and
// with focus on the button, the name "from its start", or how far the chip scrolled it.
const readChipEnds=page=>chips(page).evaluateAll(nodes=>{
  const view=nodes[0].parentElement.getBoundingClientRect();
  return Object.fromEntries(nodes.filter(chip=>{const box=chip.getBoundingClientRect();return chip.contains(document.activeElement)||box.top>=view.top-0.5&&box.bottom<=view.bottom+0.5}).map(chip=>{
    const box=chip.getBoundingClientRect(),button=chip.querySelector("button"),x=button.getBoundingClientRect(),at=document.elementFromPoint(x.left+x.width/2,x.top+x.height/2);
    // The element that holds the name: the chip itself while the name is a bare text node in its row.
    const holder=[...chip.querySelectorAll("*")].find(node=>node.textContent===chip.title)||chip,style=getComputedStyle(holder);
    const name=holder.scrollWidth<=holder.clientWidth+1?"whole":style.textOverflow==="ellipsis"&&style.overflowX!=="visible"&&!/flex|grid/.test(style.display)?"cut with an ellipsis":"cut with no ellipsis";
    const remove=x.right>box.right+0.5?`${Math.round(x.right-box.right)} px past the chip's end`:!button.contains(at)?`answers ${at?.closest(".attachment-shelf>span")===chip?"the chip's name":at?.tagName||"nothing"}`:box.right-x.right>12?`${Math.round(box.right-x.right)} px from the chip's end`:"at the chip's end";
    const scrolled=Math.round(chip.scrollLeft+holder.scrollLeft);
    return [chip.title,{name,remove,...(button===document.activeElement?{focused:scrolled?`the name scrolled ${scrolled} px`:"from its start"}:{})}];
  }));
});

// A name too long for its chip was a bare text node in the chip's row: it kept its whole width, was cut with no ellipsis and pushed
// the remove button out past the chip's end, so a click there removed nothing, and Shift+Tab to the button scrolled the name to its
// end (lane H, p109). The name gives way, cut with an ellipsis, and the button stays whole at the chip's end, the shelf scrolling too.
test("a long file name on an attachment chip is cut with an ellipsis and its remove button stays whole at the chip's end, where a click removes it and Shift+Tab reaches it with the name kept from its start, also on a shelf that scrolls, at 1280 and 700",async({page},testInfo)=>{
  test.setTimeout(150_000);
  const harness=await openComposerApp(page,{newTask:true});
  try{
    const composer=page.getByTestId("composer"),remove=name=>chips(page).getByRole("button",{name:"Remove "+name,exact:true});
    const long=["quarterly-figures-final-2026.xlsx","meeting-notes-from-monday.md","customer-interview-transcript-03.txt"],files=[long[0],"a.txt",long[1],"short.md",long[2],"plan.md"];
    const reports=Array.from({length:20},(_,index)=>`report-${String(index+1).padStart(2,"0")}-quarterly-figures.txt`);
    const ends=names=>Object.fromEntries(names.map(name=>[name,{name:long.includes(name)||reports.includes(name)?"cut with an ellipsis":"whole",remove:"at the chip's end"}]));
    for(const name of [...files,...reports])await writeFile(testInfo.outputPath(name),"contents of "+name);
    await chooseFiles(page,files.map(name=>testInfo.outputPath(name)));
    await expect(page.locator(".attachment-shelf > span:not(.uploading)")).toHaveCount(6);await expect(chips(page)).toHaveCount(6);
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      for(const width of [1280,700]){
        await page.setViewportSize({width,height:800});
        await expect.poll(()=>readChipEnds(page),{message:`three long names and three short ones at ${width}x800 in ${mode}`}).toEqual(ends(files));
        await page.screenshot({animations:"disabled",path:auditDir+`long-chip-names-${mode}-${width}x800.png`});
      }
    }
    await page.setViewportSize({width:1280,height:800});await switchMode(page,"dark");
    // A click on a long-named chip's end, where its x is, removes that chip, and the draft keeps the keyboard.
    await composer.click();await page.keyboard.type("Check these files",{delay:20});
    const box=await chips(page).filter({hasText:long[0]}).boundingBox();
    await page.mouse.click(box.x+box.width-12,box.y+box.height/2);
    await expect(chips(page).filter({hasText:long[0]}),"a click on the long-named chip's end removes it").toHaveCount(0);await expect(chips(page)).toHaveCount(5);await expect(composer).toBeFocused();
    // Shift+Tab from the draft goes back through the remove buttons, each whole at its chip's end with the name kept from its start,
    // and Enter on the first removes it, focus going on to the next.
    const order=await chips(page).evaluateAll(nodes=>nodes.map(node=>node.title));
    for(let at=order.length-1;at>=0;at--){
      await page.keyboard.press("Shift+Tab");await expect(remove(order[at])).toBeFocused();
      expect((await readChipEnds(page))[order[at]],`${order[at]} with focus on its remove button`).toEqual({...ends([order[at]])[order[at]],focused:"from its start"});
    }
    await page.keyboard.press("Enter");await expect(chips(page)).toHaveCount(4);await expect(remove(order[1])).toBeFocused();
    await expect(composer).toHaveValue("Check these files");
    // Ten more at 1280 and ten more at 700, most of the shelf long names: past three rows it scrolls, showing the newest, and the chips
    // in its view, the newest under the mouse and those Shift+Tab reaches show the same.
    for(const [width,picked] of [[1280,reports.slice(0,10)],[700,reports.slice(10)]]){
      await page.setViewportSize({width,height:800});
      const count=await chips(page).count();await chooseFiles(page,picked.map(name=>testInfo.outputPath(name)));
      await expect(page.locator(".attachment-shelf > span:not(.uploading)")).toHaveCount(count+10);await expect(chips(page)).toHaveCount(count+10);
      expect(await page.locator(".attachment-shelf").evaluate(shelf=>shelf.scrollHeight>shelf.clientHeight),`the shelf scrolls at ${width}x800`).toBe(true);
      const newest=await chips(page).last().getAttribute("title");
      await expect.poll(async()=>{const seen=await readChipEnds(page);return seen[newest]&&Object.keys(seen).length>=6&&JSON.stringify(seen)===JSON.stringify(ends(Object.keys(seen)))?"as they should":seen},{message:`the chips in the shelf's view at ${width}x800, the newest among them`}).toBe("as they should");
      await page.screenshot({animations:"disabled",path:auditDir+`long-chip-names-scrolling-shelf-dark-${width}x800.png`});
      const end=await chips(page).last().boundingBox();
      await composer.click();await page.mouse.click(end.x+end.width-12,end.y+end.height/2);
      await expect(chips(page).filter({hasText:newest}),`a click on the newest chip's end at ${width}x800 removes it`).toHaveCount(0);
      await expect(chips(page)).toHaveCount(count+9);await expect(composer).toBeFocused();
      const shown=await chips(page).evaluateAll(nodes=>nodes.map(node=>node.title));
      for(let at=shown.length-1;at>=shown.length-8;at--){
        await page.keyboard.press("Shift+Tab");await expect(remove(shown[at])).toBeFocused();
        expect((await readChipEnds(page))[shown[at]],`${shown[at]} with focus on its remove button at ${width}x800`).toEqual({...ends([shown[at]])[shown[at]],focused:"from its start"});
      }
      await page.screenshot({animations:"disabled",path:auditDir+`long-chip-name-remove-focused-dark-${width}x800.png`});
    }
    await expect(chips(page)).toHaveCount(22);await expect(composer).toHaveValue("Check these files");
  }finally{await harness.close()}
});

// The title of the button the page answers at a point, or what it answers there.
const titleAt=(page,x,y)=>page.evaluate(([x,y])=>{const node=document.elementFromPoint(x,y),button=node?.closest("button");return button?button.title:node?.tagName||"nothing"},[x,y]);
const chipTitles=page=>chips(page).evaluateAll(nodes=>nodes.map(node=>node.title));
// count files whose names are too long for their chips, attached with Attach files; their chips are all one width. Says the chips'
// names in the shelf's order.
async function attachLongNames(page,testInfo,count){
  const names=Array.from({length:count},(_,index)=>`report-${String(index+1).padStart(2,"0")}-quarterly-figures.txt`);
  for(const name of names)await writeFile(testInfo.outputPath(name),"contents of "+name);
  await chooseFiles(page,names.map(name=>testInfo.outputPath(name)));
  await expect(page.locator(".attachment-shelf > span:not(.uploading)")).toHaveCount(count);await expect(chips(page)).toHaveCount(count);
  return chipTitles(page);
}
// Opens the Browser panel and attaches count screenshots from it, each a context chip reading "Browser screenshot".
async function attachBrowserScreenshots(page,count){
  await page.locator(".sidebar").getByRole("button",{name:"Browser",exact:true}).click();
  await expect(page.getByTestId("right-panel").getByRole("button",{name:"Attach screenshot",exact:true})).toBeVisible();
  await attachScreenshots(page,count);
}

// A double click on a chip's remove button removes that chip only. Chips with names too long for them are all one width, so each
// chip's x sits where the one before had its x: the first click removed the chip at once, the next chip moved into its place, and
// the second click landed on its x and removed it too. Browser screenshots' context chips all read the same, and did the same. The
// rest of the press does nothing, as on a queued follow-up's Remove; a click of its own removes the chip under the pointer.
test("a double click on an attachment chip's or a context chip's remove button removes only that chip, where the next chip's x comes up under the pointer",async({page},testInfo)=>{
  test.setTimeout(120_000);
  await page.addInitScript(screenshotBrowser);
  const harness=await openComposerApp(page,{newTask:true});
  try{
    const composer=page.getByTestId("composer"),remove=name=>chips(page).getByRole("button",{name:"Remove "+name,exact:true});
    const shown=await attachLongNames(page,testInfo,4);
    expect(new Set(await chips(page).evaluateAll(nodes=>nodes.map(node=>Math.round(node.getBoundingClientRect().width)))).size,"the long-named chips are one width").toBe(1);
    // The person writes, then double-clicks the first chip's x: the first click removes it, and the next chip's x comes up under the
    // pointer, where the second click lands.
    await composer.click();await page.keyboard.type("Check these files",{delay:20});
    const box=await remove(shown[0]).boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.up();
    await expect(chips(page)).toHaveCount(3);
    expect(await titleAt(page,x,y),"the next chip's x under the pointer").toBe("Remove "+shown[1]);
    await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});await frames(page);
    expect.soft(await chipTitles(page),"the second click of the double click removes nothing").toEqual(shown.slice(1));
    await expect(composer).toBeFocused();await expect(composer).toHaveValue("Check these files");
    await shootBoth(page,"attachment-chip-double-click");
    // A click of its own removes the chip whose x is under the pointer.
    const left=await chipTitles(page);
    await page.mouse.click(x,y);await expect(chips(page)).toHaveCount(left.length-1);
    expect(await chipTitles(page)).toEqual(left.slice(1));
    // Three Browser screenshots, the panel closed again so the composer has them on one row, and a double click on the first one's x.
    await attachBrowserScreenshots(page,3);
    await page.getByRole("button",{name:"Close right panel"}).click();await expect(page.getByTestId("right-panel")).toHaveCount(0);
    const context=page.getByTestId("context-chip");
    expect(new Set(await context.evaluateAll(nodes=>nodes.map(node=>Math.round(node.getBoundingClientRect().top)))).size,"the three context chips share a row").toBe(1);
    const contextBox=await context.first().getByRole("button",{name:"Remove context"}).boundingBox();
    const cx=contextBox.x+contextBox.width/2,cy=contextBox.y+contextBox.height/2;
    await composer.click();
    await page.mouse.move(cx,cy);await page.mouse.down();await page.mouse.up();
    await expect(context).toHaveCount(2);
    expect(await titleAt(page,cx,cy),"the next context chip's x under the pointer").toBe("Remove context");
    await page.mouse.down({clickCount:2});await page.mouse.up({clickCount:2});await frames(page);
    expect.soft(await context.count(),"the second click of the double click removes no context chip").toBe(2);
    await expect(composer).toBeFocused();await expect(composer).toHaveValue("Check these files");
    await shootBoth(page,"context-chip-double-click");
  }finally{await harness.close()}
});

// Enter held on a chip's remove button removes that chip only: removing a chip from the keyboard gives the keyboard to the next
// chip's x, which the key's repeats pressed, so they removed chip after chip. The rest of the press does nothing, as on a queued
// follow-up's Remove; a press of its own removes the chip it is on. Eight chips, more than the repeats could take out.
test("Enter held on an attachment chip's or a context chip's remove button removes only that chip and leaves the keyboard on the next chip's x",async({page},testInfo)=>{
  test.setTimeout(120_000);
  await page.addInitScript(screenshotBrowser);
  const harness=await openComposerApp(page,{newTask:true});
  try{
    const composer=page.getByTestId("composer"),remove=name=>chips(page).getByRole("button",{name:"Remove "+name,exact:true});
    const shown=await attachLongNames(page,testInfo,8);
    await composer.click();await page.keyboard.type("Check these files",{delay:20});
    await remove(shown[0]).focus();
    await holdKey(page,"Enter",()=>expect(chips(page)).toHaveCount(7));
    expect.soft(await chipTitles(page),"Enter held removes one chip").toEqual(shown.slice(1));
    await expect.soft(remove(shown[1]),"the keyboard after Enter held on a chip's x").toBeFocused();
    await shootBoth(page,"attachment-chip-enter-held");
    // A press of its own removes the chip it is on, the keyboard going on to the next.
    const left=await chipTitles(page);
    await remove(left[0]).focus();await page.keyboard.press("Enter");
    await expect(chips(page)).toHaveCount(left.length-1);await expect(remove(left[1])).toBeFocused();
    // Eight Browser screenshots, and Enter held on the first one's x.
    await attachBrowserScreenshots(page,8);
    const context=page.getByTestId("context-chip"),removeContext=context.getByRole("button",{name:"Remove context"});
    await removeContext.first().focus();
    await holdKey(page,"Enter",()=>expect(context).toHaveCount(7));
    expect.soft(await context.count(),"Enter held removes one context chip").toBe(7);
    await expect.soft(removeContext.first(),"the keyboard after Enter held on a context chip's x").toBeFocused();
    await shootBoth(page,"context-chip-enter-held");
    await expect(composer).toHaveValue("Check these files");
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

// Escape closes the / menu for the draft as it stands, the / kept. It kept the menu closed for a bare / as long as the composer
// stayed, which it does from thread to thread: a / typed again once the draft had changed (the / erased, /p erased back to /,
// other text typed and cleared, another thread opened) showed no menu until the window reloaded. A / typed or pasted over the /
// selected (Ctrl+A, Shift+Home, a double click, a drag) leaves the draft's text as it was, so React calls no onChange for it, and
// the menu stayed closed over the / just typed until the next edit that changed the text (UI fix review, round 6).
test("after Escape closes the / menu, a / typed once the draft has changed opens it again, also back from /p, after other text, typed or pasted over the / selected, and in another thread",async({page})=>{
  test.setTimeout(120_000);
  const harness=await openComposerApp(page,{others:["Release notes"]});
  try{
    const composer=page.getByTestId("composer"),menu=page.locator(".composer-wrap .slash-menu");
    const openThread=async name=>{const row=threadRow(page,name);await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);await expect(composer).not.toHaveAttribute("placeholder","Opening thread…");await painted(page)};
    // The whole menu, as a bare / opens it, and Escape closing it with the / kept, for as long as the draft stays.
    const shows=how=>expect.soft(menu.getByText("/new",{exact:true}),how).toBeVisible();
    const escape=async()=>{await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);await expect(composer).toHaveValue("/");await frames(page);await expect(menu).toHaveCount(0)};
    // Where the / is drawn in the composer (its first character, at the top left of its text), and just right of it.
    const slashAt=dx=>composer.evaluate((node,dx)=>{const style=getComputedStyle(node),line=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2;return {x:parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft)+dx,y:parseFloat(style.borderTopWidth)+parseFloat(style.paddingTop)+line/2}},dx);
    const selected=how=>expect.poll(()=>composer.evaluate(node=>[node.selectionStart,node.selectionEnd]),{message:`the / ${how}`}).toEqual([0,1]);
    // The / selected as a person selects it, each way after Escape has closed the menu over it.
    const selections=[
      ["selected with Ctrl+A",()=>page.keyboard.press("Control+A")],
      ["selected with Shift+Home",()=>page.keyboard.press("Shift+Home")],
      ["selected with a double click",async()=>composer.dblclick({position:await slashAt(2)})],
      ["selected with a drag",async()=>{const box=await composer.boundingBox(),from=await slashAt(14),to=await slashAt(0);await page.mouse.move(box.x+from.x,box.y+from.y);await page.mouse.down();await page.mouse.move(box.x+(from.x+to.x)/2,box.y+to.y,{steps:4});await page.mouse.move(box.x+to.x,box.y+to.y,{steps:4});await page.mouse.up()}],
    ];
    for(const [mode,other] of [["dark","Release notes"],["light","Composer thread"]]){
      await switchMode(page,mode);
      await composer.click();await expect(composer).toHaveValue("");
      await page.keyboard.type("/",{delay:20});await shows(`the first / in ${mode}`);await escape();
      await page.keyboard.press("Backspace");await expect(composer).toHaveValue("");
      await page.keyboard.type("/",{delay:20});await shows(`a / typed again after Escape in ${mode}`);
      await page.screenshot({animations:"disabled",path:auditDir+`slash-menu-typed-again-after-escape-${mode}-1280x800.png`});
      // The / selected and typed over with a /, or a / pasted over it: the draft reads / again, and the menu opens for the new /.
      for(const [how,select] of selections){
        await escape();await select();await selected(how);
        await page.keyboard.type("/",{delay:20});await expect(composer).toHaveValue("/");await shows(`a / typed over the / ${how} after Escape in ${mode}`);
      }
      await page.screenshot({animations:"disabled",path:auditDir+`slash-menu-typed-over-selected-slash-after-escape-${mode}-1280x800.png`});
      await escape();await page.keyboard.press("Control+A");await selected("selected with Ctrl+A for the paste");
      await pasteText(page,"/");await expect(composer).toHaveValue("/");await shows(`a / pasted over the / after Escape in ${mode}`);
      await page.screenshot({animations:"disabled",path:auditDir+`slash-menu-pasted-over-slash-after-escape-${mode}-1280x800.png`});
      await escape();await page.keyboard.type("p",{delay:20});await expect(menu.getByText("/plan",{exact:true})).toBeVisible();
      await page.keyboard.press("Backspace");await expect(composer).toHaveValue("/");await shows(`/p erased back to / after Escape in ${mode}`);
      await escape();await page.keyboard.press("Backspace");await page.keyboard.type("Fix the login",{delay:20});
      await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");await expect(composer).toHaveValue("");
      await page.keyboard.type("/",{delay:20});await shows(`a / after other text after Escape in ${mode}`);
      await escape();await page.keyboard.press("Backspace");await openThread(other);
      await composer.click();await page.keyboard.type("/",{delay:20});await shows(`a / in ${other} after Escape in the thread before, in ${mode}`);
      await page.screenshot({animations:"disabled",path:auditDir+`slash-menu-another-thread-after-escape-${mode}-1280x800.png`});
      await page.keyboard.press("Backspace");await expect(menu).toHaveCount(0);
    }
  }finally{await harness.close()}
});

// The composer's search for the word at its caret, which fills the @ menu, as the GUI server answers it; and a click dx px right of
// where the character at index starts on the draft's first line, as a person clicks the caret there.
const mentionSearched=(page,q)=>page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==="/api/workspace/search"&&url.searchParams.get("q")===q});
async function clickInDraft(page,index,dx){
  const composer=page.getByTestId("composer");
  await composer.click({position:await composer.evaluate((node,[index,dx])=>{
    const style=getComputedStyle(node),ruler=document.createElement("canvas").getContext("2d");ruler.font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return {x:parseFloat(style.paddingLeft)+ruler.measureText(node.value.slice(0,index)).width+dx,y:parseFloat(style.paddingTop)+(parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2)/2};
  },[index,dx])});
}

// Escape's dismissal of the / or @ menu goes with the draft, which App keeps while a page (Settings, History) takes the chat's place
// and the composer with it. The composer drawn again on the way back opened the / menu by itself over the unchanged /, the keyboard
// still on the sidebar, and Enter in the composer then completed /compact instead of sending the / (round 7). An edit still opens it.
test("after Escape closes the / or @ menu, Settings or History and back to the chat leave it shut over the unchanged draft, an edit opens it again, and Enter sends the draft as typed",async({page})=>{
  test.setTimeout(150_000);
  const harness=await openComposerApp(page,{replies:[{text:"Sent the slash as typed."}]});
  try{
    await writeLoginFiles(harness);
    const composer=page.getByTestId("composer"),slash=page.locator(".composer-wrap .slash-menu"),mention=page.getByTestId("file-mention-menu"),destinations=page.getByRole("navigation",{name:"Destinations"});
    // The draft typed into the emptied composer, its menu open, and Escape closing the menu with the draft kept.
    const escaped=async(text,menu)=>{
      await composer.click();await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");await expect(composer).toHaveValue("");
      await page.keyboard.type(text,{delay:20});await expect(menu).toBeVisible();await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);await expect(composer).toHaveValue(text);
    };
    // A page opened from the sidebar (or Settings with its key), the composer gone with the chat, and the chat again through Threads
    // (the sidebar's brand) or the thread's row.
    const awayAndBack=async(name,heading,back)=>{
      if(name==="Ctrl+,")await page.keyboard.press("Control+Comma");else await destinations.getByRole("button",{name,exact:true}).click();
      await expect(page.getByRole("heading",{name:heading,exact:true,level:1})).toBeVisible();await expect(composer).toHaveCount(0);
      await (back==="Threads"?page.getByRole("button",{name:"Threads",exact:true}):threadRow(page,"Composer thread").locator(".thread-main")).click();
      await expect(composer).toBeEnabled();await painted(page);
    };
    for(const [mode,width] of [["dark",1280],["light",900]]){
      await switchMode(page,mode);await page.setViewportSize({width,height:800});
      for(const [name,heading,back] of [["Settings","Settings","Threads"],["Settings","Settings","the thread's row"],["Ctrl+,","Settings","the thread's row"],["History","Thread history","the thread's row"]]){
        await escaped("/",slash);await awayAndBack(name,heading,back);
        await expect.soft(slash,`the / menu back from ${name} through ${back} in ${mode} at ${width}`).toHaveCount(0);await expect(composer).toHaveValue("/");
      }
      await page.screenshot({animations:"disabled",path:auditDir+`slash-menu-shut-after-history-and-back-${mode}-${width}x800.png`});
      // The @ menu as well: back in the composer, a click past the draft's end searches for the word at the caret again, and the
      // menu stays shut.
      await escaped("Check @log",mention);await awayAndBack("Settings","Settings","Threads");
      const answered=mentionSearched(page,"log");await clickInDraft(page,10,40);await (await answered).finished();await painted(page);
      await expect.soft(mention,`the @ menu back from Settings in ${mode} at ${width}`).toHaveCount(0);await expect(composer).toHaveValue("Check @log");
    }
    await page.setViewportSize({width:1280,height:800});
    // An edit back in the composer opens the menu again: /p, and the p erased back to /.
    await escaped("/",slash);await awayAndBack("Settings","Settings","Threads");
    await composer.click();await page.keyboard.type("p",{delay:20});await expect(slash.getByText("/plan",{exact:true})).toBeVisible();
    await page.keyboard.press("Backspace");await expect(composer).toHaveValue("/");await expect(slash.getByText("/new",{exact:true})).toBeVisible();
    // Enter sends the / as Escape left it, back from History.
    await page.keyboard.press("Escape");await expect(slash).toHaveCount(0);await awayAndBack("History","Thread history","the thread's row");
    await composer.click();await page.keyboard.press("End");await page.keyboard.press("Enter");
    await expect(page.getByText("Sent the slash as typed.",{exact:true})).toBeVisible({timeout:15_000});
    expect(sentTexts(harness),"the messages the thread has").toEqual(["Look at the login page","/"]);await expect(composer).toHaveValue("");
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

// Escape closes the @ menu for the draft as it stands, as it closes the / menu: the menu stays shut while the caret moves with no
// edit (an arrow key, Home and End, a click in the word or past the draft's end), and Enter then sends the message as typed. Each
// move searched again for the word at the caret and opened the menu over the draft, and Enter attached the file it highlighted
// instead of sending (round 7). An edit opens it again, also one that leaves the draft's text as it was (a letter typed over itself).
test("after Escape closes the @ file menu, the arrow keys, Home and End or a click leave it shut and Enter sends the message as typed, and an edit opens it again",async({page})=>{
  test.setTimeout(150_000);
  const replies=["Sent as typed, with no file.","Sent as typed again, with no file."];
  const harness=await openComposerApp(page,{replies:replies.map(text=>({text}))});
  try{
    await writeLoginFiles(harness);
    const composer=page.getByTestId("composer"),menu=page.getByTestId("file-mention-menu"),context=page.getByTestId("context-chip");
    // A move of the caret into another word of the mention, the composer's search for that word answered and drawn: the menu stays shut.
    const stays=async(how,q,move)=>{const answered=mentionSearched(page,q);await move();await (await answered).finished();await painted(page);await expect.soft(menu,`the @ menu after Escape and ${how}`).toHaveCount(0)};
    for(const [mode,width,reply] of [["dark",1280,replies[0]],["light",900,replies[1]]]){
      await switchMode(page,mode);await page.setViewportSize({width,height:800});
      const where=` in ${mode} at ${width}`;
      await composer.click();await expect(composer).toHaveValue("");
      await page.keyboard.type("Check @log",{delay:20});await expect(menu.locator("button.active strong")).toHaveText("login.js");
      await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);await expect(composer).toHaveValue("Check @log");
      await stays("ArrowLeft"+where,"lo",()=>page.keyboard.press("ArrowLeft"));
      await page.screenshot({animations:"disabled",path:auditDir+`mention-menu-shut-after-escape-and-arrowleft-${mode}-${width}x800.png`});
      await stays("ArrowRight"+where,"log",()=>page.keyboard.press("ArrowRight"));
      await page.keyboard.press("Home");await stays("Home and End"+where,"log",()=>page.keyboard.press("End"));
      await stays("a click inside @log"+where,"lo",()=>clickInDraft(page,9,2));
      await stays("a click past the draft's end"+where,"log",()=>clickInDraft(page,10,40));
      // Enter sends the draft as typed, with no file.
      await page.keyboard.press("Enter");
      await expect(page.getByText(reply,{exact:true})).toBeVisible({timeout:15_000});
      await expect(composer).toHaveValue("");await expect(context).toHaveCount(0);
      await page.screenshot({animations:"disabled",path:auditDir+`mention-menu-enter-sends-after-escape-${mode}-${width}x800.png`});
    }
    expect(sentTexts(harness),"the messages the thread has").toEqual(["Look at the login page","Check @log","Check @log"]);
    await page.setViewportSize({width:1280,height:800});
    // An edit opens the menu again: a letter typed, a letter erased, a letter typed over itself.
    await composer.click();await page.keyboard.type("Check @log",{delay:20});await expect(menu).toBeVisible();await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
    await page.keyboard.type("i",{delay:20});await expect(menu.locator("button.active strong")).toHaveText("login.js");
    await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);await page.keyboard.press("Backspace");await expect(composer).toHaveValue("Check @log");await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
    await stays("Shift+ArrowLeft","lo",()=>page.keyboard.press("Shift+ArrowLeft"));
    await page.keyboard.type("g",{delay:20});await expect(composer).toHaveValue("Check @log");await expect(menu.locator("button.active strong")).toHaveText("login.js");
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

// What a person sees of the composer with chips on its attachment shelf: the typed draft (at its first line's start and its middle),
// the + (Attach files) and the mode picker (at their top edge and middle), each "clear" when no chip lies over it and the page answers
// it there, or else the chips over it and what the page answers; and the chips, "whole" when the page answers each in the shelf's view.
const readComposerClear=page=>page.evaluate(()=>{
  const wrap=document.querySelector(".chat-workspace .composer-wrap"),shelf=wrap.querySelector(".attachment-shelf"),chips=[...shelf.children],view=shelf.getBoundingClientRect();
  const named=node=>node?.closest(".attachment-shelf>span")?.title||(typeof node?.className==="string"&&node.className)||node?.tagName||"nothing";
  const clear=(node,points)=>{
    const box=node.getBoundingClientRect(),under=chips.filter(chip=>{const b=chip.getBoundingClientRect();return b.left<box.right-1&&box.left<b.right-1&&b.top<box.bottom-1&&box.top<b.bottom-1});
    const at=points(box).map(([x,y])=>document.elementFromPoint(x,y));
    return !under.length&&at.every(hit=>node.contains(hit))?"clear":`under ${under.map(named).join(", ")||"no chip"}, answers ${at.map(named).join(" and ")}`;
  };
  const edgeAndMiddle=box=>[[box.left+box.width/2,box.top+3],[box.left+box.width/2,box.top+box.height/2]];
  const unseen=chips.filter(chip=>{const b=chip.getBoundingClientRect();return b.top<view.top-0.5||b.bottom>view.bottom+0.5||!chip.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))});
  return {draft:clear(wrap.querySelector("textarea"),box=>[[box.left+30,box.top+22],[box.left+box.width/2,box.top+box.height/2]]),attach:clear(wrap.querySelector('button[aria-label="Attach files"]'),edgeAndMiddle),
    mode:clear(wrap.querySelector(".composer-left select.permission-picker"),edgeAndMiddle),chips:unseen.length?unseen.map(named).join(", ")+" out of view":"whole"};
});
const composerClear={draft:"clear",attach:"clear",mode:"clear",chips:"whole"};

// Screenshots pasted one by one onto a typed draft: the attachment shelf stood a row above the composer and wrapped down onto it, so
// at 1280 the sixth chip and those after it (at 900 the fifth) lay over the draft and took a click on it, and at 700 a third row lay
// over the + and the mode picker, which took no click. The shelf's rows go up from the composer's top, the thread and a refused file's
// message end above them, and past three rows the shelf scrolls, showing the newest, on a thread and on New task alike.
test("screenshots pasted onto a draft stack up above the composer and leave the draft, the + and the mode picker clear to click, on a thread and on New task at 1280, 900 and 700",async({page},testInfo)=>{
  test.setTimeout(180_000);
  const harness=await openComposerApp(page,{turns:[{user:"Explain the login flow",items:[replyItem("login-reply",LONG_REPLY)]}]});
  try{
    const composer=page.getByTestId("composer"),uploading=page.locator(".attachment-shelf > span.uploading"),alert=page.getByTestId("app-action-error");
    // Pasted one at a time, each waited on until it is in.
    const paste=async(prefix,from,to)=>{for(let index=from;index<=to;index++){await pasteImage(page,`${prefix}-${String(index).padStart(2,"0")}.png`);await expect(chips(page)).toHaveCount(index);await expect(uploading).toHaveCount(0)}};
    await wheelThread(page,1200,6);
    await composer.click();await page.keyboard.type("Look at these screenshots",{delay:20});
    await paste("screenshot",1,9);
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      for(const width of [1280,900,700]){
        await page.setViewportSize({width,height:800});
        await expect.poll(()=>readComposerClear(page),{message:`nine screenshots on a thread at ${width}x800 in ${mode}`}).toEqual(composerClear);
        await expect.poll(()=>readReplyEnd(page),{message:`the reply's end above nine screenshots at ${width}x800 in ${mode}`}).toEqual(replyEndClear);
        await page.screenshot({animations:"disabled",path:auditDir+`nine-screenshots-thread-${mode}-${width}x800.png`});
      }
    }
    // At 700, three rows of chips: the + opens the file chooser and the mode picker takes a click; there and at 1280, a click on the
    // start of the draft puts the caret there.
    const [chooser]=await Promise.all([page.waitForEvent("filechooser",{timeout:5000}),page.getByRole("button",{name:"Attach files"}).click({timeout:5000})]);await chooser.setFiles([]);
    await page.locator(".composer-left select.permission-picker").first().click({trial:true,timeout:5000});
    for(const width of [700,1280]){
      await page.setViewportSize({width,height:800});
      await page.locator(".conversation-scroll").click({position:{x:12,y:12}});await expect(composer).not.toBeFocused();
      const box=await composer.boundingBox();await page.mouse.click(box.x+18,box.y+22);
      await expect(composer,`a click on the start of the draft at ${width}x800`).toBeFocused();
      expect(await composer.evaluate(node=>node.selectionStart)).toBeLessThanOrEqual(1);
    }
    await expect(composer).toHaveValue("Look at these screenshots");await expect(chips(page)).toHaveCount(9);
    // A file refused beside them is said above the shelf's top row, at 1280 (two rows) and 700 (three).
    const big=testInfo.outputPath("recording.bin");await writeFile(big,Buffer.alloc(51*1024*1024,7));
    for(const width of [1280,700]){
      await page.setViewportSize({width,height:800});
      await chooseFiles(page,big);await expect(alert).toHaveText("Could not attach files: recording.bin: Attachment is larger than 50 MB",{timeout:2000});
      const [toast,top]=await Promise.all([alert.boundingBox(),chips(page).first().boundingBox()]);
      expect(toast.y+toast.height,`the refusal above the shelf's top row at ${width}x800`).toBeLessThanOrEqual(top.y);
    }
    await page.screenshot({animations:"disabled",path:auditDir+"nine-screenshots-refusal-light-700x800.png"});
    await expect(alert).toBeHidden({timeout:10_000});
    // On New task, six screenshots (two rows at 1280) leave the draft, the + and the mode picker clear, and the suggestions too.
    await page.setViewportSize({width:1280,height:800});
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"New task",exact:true}).click();
    await expect(page.locator(".welcome h1")).toHaveText("What do you want to build?");await expect(chips(page)).toHaveCount(0);
    await composer.click();await page.keyboard.type("New task with screenshots",{delay:20});
    await paste("welcome",1,6);
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      for(const width of [1280,900,700]){
        await page.setViewportSize({width,height:800});
        await expect.poll(()=>readComposerClear(page),{message:`six screenshots on New task at ${width}x800 in ${mode}`}).toEqual(composerClear);
        await expect.poll(()=>readSuggestions(page),{message:`the suggestions above six screenshots at ${width}x800 in ${mode}`}).toEqual(suggestionsClear);
        await page.screenshot({animations:"disabled",path:auditDir+`six-screenshots-new-task-${mode}-${width}x800.png`});
      }
    }
    // Past about three rows the shelf scrolls, with the theme's own scrollbar as the conversation has it, and each screenshot pasted
    // brings the newest into view with a part of the row above it showing, so the older chips are seen to be there, the controls still
    // clear; a composer drawn again (New task again after Settings) shows the newest too. It scrolled with the platform's thin bar, which
    // macOS shows only while it scrolls, cut exactly between rows, and a composer drawn again opened on its oldest rows: 18 screenshots
    // showed 10, and nothing said 8 more were attached. rowAbove: what shows of the row above the shelf's top.
    const shelfEnd=()=>page.locator(".attachment-shelf").evaluate(shelf=>{
      const view=shelf.getBoundingClientRect(),last=shelf.lastElementChild.getBoundingClientRect();
      const above=Math.max(0,...[...shelf.children].map(chip=>chip.getBoundingClientRect()).filter(box=>box.top<view.top-0.5).map(box=>Math.round(Math.min(box.bottom,view.bottom)-view.top)));
      return {scrolls:shelf.scrollHeight>shelf.clientHeight,newest:last.top>=view.top-0.5&&last.bottom<=view.bottom+0.5?"in view":"out of view",rowAbove:above>=6?"shows in part":`hidden (${above}px)`};
    });
    const scrollbars=()=>page.evaluate(()=>{
      const bar=node=>{const {scrollbarWidth,scrollbarColor}=getComputedStyle(node);return {scrollbarWidth,scrollbarColor}},shelf=document.querySelector(".chat-workspace .attachment-shelf");
      return {shelf:bar(shelf),conversation:bar(document.querySelector(".chat-workspace .conversation-scroll")),shelfGutter:shelf.offsetWidth-shelf.clientWidth};
    });
    const capped={scrolls:true,newest:"in view",rowAbove:"shows in part"};
    for(const [width,count] of [[1280,17],[700,18]]){
      await page.setViewportSize({width,height:800});await paste("welcome",await chips(page).count()+1,count);
      await expect.poll(async()=>{const {draft,attach,mode}=await readComposerClear(page),{scrolls,newest}=await shelfEnd();return {draft,attach,mode,scrolls,newest}},{message:`${count} screenshots on New task at ${width}x800`}).toEqual({draft:"clear",attach:"clear",mode:"clear",scrolls:true,newest:"in view"});
      expect.soft((await shelfEnd()).rowAbove,`a part of the row above the newest shows with ${count} screenshots at ${width}x800`).toBe("shows in part");
      const bars=await scrollbars();testInfo.annotations.push({type:`scrollbars with ${count} screenshots at ${width}x800`,description:JSON.stringify(bars)});
      expect.soft(bars.shelf,`the shelf's scrollbar at ${width}x800 is the theme's, as the conversation's`).toEqual(bars.conversation);
      await page.screenshot({animations:"disabled",path:auditDir+`${count}-screenshots-new-task-light-${width}x800.png`});
    }
    await page.setViewportSize({width:1280,height:800});
    const destinations=page.getByRole("navigation",{name:"Destinations"});
    await destinations.getByRole("button",{name:"Settings",exact:true}).click();await expect(composer).toHaveCount(0);
    await destinations.getByRole("button",{name:"New task",exact:true}).click();await expect(chips(page)).toHaveCount(18);
    await expect.poll(shelfEnd,{message:"18 screenshots on New task again after Settings"}).toEqual(capped);
    await page.screenshot({animations:"disabled",path:auditDir+"18-screenshots-new-task-after-settings-light-1280x800.png"});
    await expect(composer).toHaveValue("New task with screenshots");
  }finally{await harness.close()}
});

// A stash store that takes no draft, so each Ctrl+S fails into the app's error toast, and two files for the @ menu to list on "@log".
const failStashes=page=>page.route(/\/api\/stashes(?:\?.*)?$/,route=>route.request().method()==="POST"?route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"The stash store is read-only."})}):json(route,{stashes:[]}));
const stashFailed="Could not stash or restore draft: The stash store is read-only.";
async function writeLoginFiles(harness){
  await mkdir(join(harness.repo,"src"),{recursive:true});
  for(const name of ["login","logout"])await writeFile(join(harness.repo,"src",name+".js"),`export function ${name}(){}\n`);
}
// The app's error toast as a person sees it: its lines, its place (under the header, or just above the attachment shelf's top row, or
// where it is), and the open / or @ menu, "clear" when the toast lies over no part of it.
const readErrorToast=page=>page.evaluate(()=>{
  const toast=document.querySelector("[data-testid=app-action-error]"),menu=document.querySelector(".composer-wrap .slash-menu,.composer-wrap [data-testid=file-mention-menu]");
  const header=document.querySelector(".chat-workspace .workspace-header").getBoundingClientRect(),rowTop=Math.min(...[...document.querySelectorAll(".chat-workspace .attachment-shelf>span")].map(chip=>chip.getBoundingClientRect().top));
  const box=toast.getBoundingClientRect(),style=getComputedStyle(toast),open=menu?.getBoundingClientRect();
  return {lines:Math.round((toast.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom))/parseFloat(style.lineHeight)),
    place:box.top>=header.bottom&&box.top<=header.bottom+16?"under the header":box.bottom<=rowTop&&box.bottom>=rowTop-16?"above the shelf's top row":`${Math.round(box.top)}-${Math.round(box.bottom)}`,
    menu:!open?"none":box.bottom<=open.top||box.top>=open.bottom||box.right<=open.left||box.left>=open.right?"clear":"under the toast"};
});

// With chips on the shelf and the / or @ menu open, the rule that sets the toast's foot above the shelf and the one that sets its head
// under the header both applied, so a failed action's toast stretched from the header to the shelf, a red box over the conversation and
// the menu. With a menu open the toast goes under the header in its one line, as with no chips; with the menu closed, above the shelf.
test("with screenshots on the shelf and the / or @ menu open, a failed Ctrl+S says so in a one-line toast under the header, clear of the menu, and above the shelf once the menu closes",async({page})=>{
  test.setTimeout(120_000);
  const harness=await openComposerApp(page);await failStashes(page);
  try{
    await writeLoginFiles(harness);
    const composer=page.getByTestId("composer"),alert=page.getByTestId("app-action-error");
    await composer.click();
    for(const name of ["menu-shot-1.png","menu-shot-2.png"]){await pasteImage(page,name);await expect(chips(page).filter({hasText:name})).toBeVisible()}
    await expect(page.locator(".attachment-shelf > span.uploading")).toHaveCount(0);
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      // A command word whose menu Escape closed keeps it closed when typed again, so the light pass types another.
      for(const [typed,menu,kind] of [[mode==="dark"?"/":"/p",page.locator(".composer-wrap .slash-menu"),"slash"],["Check @log",page.getByTestId("file-mention-menu"),"mention"]]){
        await composer.click();await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");
        await page.keyboard.type(typed,{delay:20});await expect(menu).toBeVisible();
        await page.keyboard.press("Control+s");await expect(alert).toHaveText(stashFailed);
        for(const width of [1280,900]){
          await page.setViewportSize({width,height:800});await expect(menu).toBeVisible();
          await expect.poll(()=>readErrorToast(page),{message:`the toast with the ${kind} menu open at ${width}x800 in ${mode}`}).toEqual({lines:1,place:"under the header",menu:"clear"});
          await page.screenshot({animations:"disabled",path:auditDir+`chips-${kind}-menu-failed-stash-${mode}-${width}x800.png`});
        }
        // Escape closes the menu, and the toast goes down above the shelf's top row; the next Ctrl+S's toast is there too.
        await page.setViewportSize({width:1280,height:800});
        await page.keyboard.press("Escape");await expect(menu).toBeHidden();
        await expect.poll(()=>readErrorToast(page),{message:`the toast once the ${kind} menu closed in ${mode}`}).toEqual({lines:1,place:"above the shelf's top row",menu:"none"});
        await page.keyboard.press("Control+s");await expect(alert).toHaveText(stashFailed);
        await expect.poll(()=>readErrorToast(page),{message:`the next toast with the ${kind} menu closed in ${mode}`}).toEqual({lines:1,place:"above the shelf's top row",menu:"none"});
        await expect(composer).toHaveValue(typed);await expect(chips(page)).toHaveCount(2);
      }
    }
  }finally{await harness.close()}
});

// An archive's undo toast against the attachment shelf: its place (just above the shelf's top row, or where it is), an error toast's
// beside it, and the chips, "whole" when the page answers each chip and its remove button at their middle, or else the ones it does not.
const readUndoToast=page=>page.evaluate(()=>{
  const undo=document.querySelector("[data-testid=thread-undo-toast]").getBoundingClientRect(),error=document.querySelector("[data-testid=app-action-error]")?.getBoundingClientRect();
  const chips=[...document.querySelectorAll(".chat-workspace .attachment-shelf>span")],rowTop=Math.min(...chips.map(chip=>chip.getBoundingClientRect().top));
  const answers=node=>{const box=node.getBoundingClientRect();return node.contains(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2))};
  const hidden=chips.filter(chip=>!answers(chip)||!answers(chip.querySelector("button"))).map(chip=>chip.title);
  return {undo:undo.bottom<=rowTop&&undo.bottom>=rowTop-16?"above the shelf's top row":`${Math.round(undo.top)}-${Math.round(undo.bottom)}, the shelf's top row at ${Math.round(rowTop)}`,
    ...(error?{error:error.bottom<=undo.top?"above the undo toast":`${Math.round(error.top)}-${Math.round(error.bottom)}, the undo toast at ${Math.round(undo.top)}-${Math.round(undo.bottom)}`}:{}),
    chips:hidden.length?hidden.join(", ")+" under a toast":"whole"};
});
const threadRow=(page,name)=>page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});
// Archive from the thread's row menu in the sidebar, as a person does, and its Undo on the toast it brings.
async function archiveThread(page,name){
  const row=threadRow(page,name);await row.hover();await row.locator(".thread-menu summary").click();await expect(row.locator(".thread-menu")).toHaveAttribute("open","");
  await row.getByRole("button",{name:"Archive",exact:true}).click();await expect(row).toHaveCount(0);await expect(page.getByTestId("thread-undo-toast")).toContainText("Thread archived");
}
async function undoArchive(page){
  const toast=page.getByTestId("thread-undo-toast");await toast.getByRole("button",{name:"Undo",exact:true}).click();await expect(toast).toHaveCount(0);
}

// The undo toast of an archive sat 12 px above the composer's top, where the attachment shelf now stands, over the middle of its rows:
// chips' names and remove buttons under it could not be read or clicked for its 5 s. It sits above the shelf's top row, as the error
// toast does, and the error toast of a refused Undo above it.
test("an archive's undo toast sits above the attachment shelf's top row, so every chip and its remove button stay clickable, and a refused Undo's error toast sits above it",async({page})=>{
  test.setTimeout(120_000);
  let refuseUndo=false;
  const harness=await openComposerApp(page,{others:["Archive me A","Archive me B"],refuse:message=>refuseUndo&&message.method==="thread/unarchive"?"Archive store is read-only":null});
  try{
    const composer=page.getByTestId("composer"),undoToast=page.getByTestId("thread-undo-toast"),alert=page.getByTestId("app-action-error");
    // Nine screenshots pasted one at a time onto a typed draft: two rows of chips at 1280, three at 900.
    await composer.click();await page.keyboard.type("Look at these screenshots",{delay:20});
    for(let index=1;index<=9;index++){await pasteImage(page,`shelf-${String(index).padStart(2,"0")}.png`);await expect(chips(page)).toHaveCount(index);await expect(page.locator(".attachment-shelf > span.uploading")).toHaveCount(0)}
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      await archiveThread(page,"Archive me A");
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});
        await expect.poll(()=>readUndoToast(page),{message:`the undo toast over nine chips at ${width}x800 in ${mode}`}).toEqual({undo:"above the shelf's top row",chips:"whole"});
        await page.screenshot({animations:"disabled",path:auditDir+`undo-toast-nine-chips-${mode}-${width}x800.png`});
      }
      await page.setViewportSize({width:1280,height:800});
      await undoArchive(page);await expect(threadRow(page,"Archive me A")).toHaveCount(1);
    }
    // An Undo the harness refuses says so in the error toast; an archive meanwhile brings an undo toast beside it, under it.
    refuseUndo=true;await archiveThread(page,"Archive me A");await undoArchive(page);
    await expect(alert).toHaveText("Could not put back “Archive me A”: Archive store is read-only.");
    refuseUndo=false;await archiveThread(page,"Archive me B");
    await expect.poll(()=>readUndoToast(page),{message:"the error toast and the undo toast over nine chips"}).toEqual({undo:"above the shelf's top row",error:"above the undo toast",chips:"whole"});
    await page.screenshot({animations:"disabled",path:auditDir+"undo-and-error-toasts-nine-chips-light-1280x800.png"});
    // A click on the remove button of the third chip, at the toast's height, removes that chip and leaves the undo toast up.
    const remove=await chips(page).getByRole("button",{name:"Remove shelf-03.png",exact:true}).boundingBox();
    await page.mouse.click(remove.x+remove.width/2,remove.y+remove.height/2);
    await expect(chips(page)).toHaveCount(8);await expect(chips(page).filter({hasText:"shelf-03.png"})).toHaveCount(0);await expect(undoToast).toContainText("Thread archived");
    await undoArchive(page);await expect(threadRow(page,"Archive me B")).toHaveCount(1);
    await expect(composer).toHaveValue("Look at these screenshots");
  }finally{await harness.close()}
});

// The two toasts against the header and an open / or @ menu or model picker: the undo toast's place, the error toast's against it,
// and the menu, "clear" when neither toast lies over any part of it.
const readMenuToasts=page=>page.evaluate(()=>{
  const box=selector=>document.querySelector(selector)?.getBoundingClientRect(),over=(a,b)=>Boolean(a&&b&&a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom);
  const header=box(".chat-workspace .workspace-header"),undo=box("[data-testid=thread-undo-toast]"),error=box("[data-testid=app-action-error]"),menu=box(".composer-wrap .slash-menu")||box(".composer-wrap [data-testid=file-mention-menu]")||box(".composer-wrap .model-picker-menu");
  const at=node=>`${Math.round(node.top)}-${Math.round(node.bottom)}`;
  return {undo:undo.top>=header.bottom&&undo.top<=header.bottom+16?"under the header":at(undo),
    ...(error?{error:error.top>=undo.bottom?"under the undo toast":`${at(error)}, the undo toast at ${at(undo)}`}:{}),
    menu:over(undo,menu)||over(error,menu)?"under a toast":"clear"};
});

// The menus open upward over the space above the composer, where an archive's undo toast sat, over their last rows. With a menu open
// the undo toast shows under the header, as the error toast does, and a failed action's toast under it.
test("with the / or @ menu open, an archive's undo toast shows under the header, clear of the menu, and a failed Ctrl+S's toast under it",async({page})=>{
  test.setTimeout(120_000);
  const harness=await openComposerApp(page,{others:["Archive me A"]});await failStashes(page);
  try{
    await writeLoginFiles(harness);
    const composer=page.getByTestId("composer"),alert=page.getByTestId("app-action-error");
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      for(const [typed,menu,kind] of [["/",page.locator(".composer-wrap .slash-menu"),"slash"],["Check @log",page.getByTestId("file-mention-menu"),"mention"]]){
        await expect(alert).toHaveCount(0,{timeout:10_000});
        await composer.click();await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");
        await page.keyboard.type(typed,{delay:20});await expect(menu).toBeVisible();
        await archiveThread(page,"Archive me A");await expect(menu).toBeVisible();
        await expect.poll(()=>readMenuToasts(page),{message:`the undo toast with the ${kind} menu open in ${mode}`}).toEqual({undo:"under the header",menu:"clear"});
        await page.keyboard.press("Control+s");await expect(alert).toHaveText(stashFailed);
        for(const width of [1280,900]){
          await page.setViewportSize({width,height:800});await expect(menu).toBeVisible();
          await expect.poll(()=>readMenuToasts(page),{message:`both toasts with the ${kind} menu open at ${width}x800 in ${mode}`}).toEqual({undo:"under the header",error:"under the undo toast",menu:"clear"});
          await page.screenshot({animations:"disabled",path:auditDir+`undo-and-error-toasts-${kind}-menu-${mode}-${width}x800.png`});
        }
        await page.setViewportSize({width:1280,height:800});
        await undoArchive(page);await expect(threadRow(page,"Archive me A")).toHaveCount(1);
        await expect(composer).toHaveValue(typed);
      }
    }
  }finally{await harness.close()}
});

// The model picker closes on a press anywhere outside it, and while it is open the toasts stand under the header: a press on the
// undo toast's Undo closed the picker, the toast went back above the composer between the press and the release, and the click went
// to the page instead of Undo, so the thread stayed archived with the toast out of reach. A press on either toast leaves the picker
// open, so the toast stays where it was pressed: a mouse click on Undo brings the thread back, and a drag over a failed action's
// words selects them.
test("with the model picker open, a mouse click on the undo toast's Undo brings the archived thread back, and a drag over a failed action's toast selects its words, the picker staying open and the toasts where they were pressed",async({page})=>{
  test.setTimeout(120_000);
  const harness=await openComposerApp(page,{others:["Archive me A"]});await failStashes(page);
  try{
    const composer=page.getByTestId("composer"),picker=page.getByTestId("model-picker"),menu=page.locator(".composer-wrap .model-picker-menu");
    const undoToast=page.getByTestId("thread-undo-toast"),alert=page.getByTestId("app-action-error");
    const place=locator=>locator.evaluate(node=>{const box=node.getBoundingClientRect();return [box.left,box.top,box.width,box.height].map(Math.round).join(",")});
    for(const [mode,width] of [["dark",1280],["light",900]]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);await page.setViewportSize({width,height:800});
      await expect(alert).toHaveCount(0,{timeout:10_000});
      await archiveThread(page,"Archive me A");
      await picker.click();await expect(menu).toBeVisible();
      await expect.poll(()=>readMenuToasts(page),{message:`the undo toast with the model picker open at ${width}x800 in ${mode}`}).toEqual({undo:"under the header",menu:"clear"});
      await page.screenshot({animations:"disabled",path:auditDir+`undo-toast-model-picker-${mode}-${width}x800.png`});
      // Undo clicked with the mouse, as a person clicks it: the press, then the release where it was pressed.
      const undo=await undoToast.getByRole("button",{name:"Undo",exact:true}).boundingBox();
      await page.mouse.click(undo.x+undo.width/2,undo.y+undo.height/2);
      await expect(threadRow(page,"Archive me A"),`the archived thread is back after a click on Undo at ${width}x800 in ${mode}`).toHaveCount(1);
      await expect(undoToast).toHaveCount(0);await expect(menu,"the picker stays open after a click on a toast").toBeVisible();
      await page.screenshot({animations:"disabled",path:auditDir+`undo-clicked-model-picker-${mode}-${width}x800.png`});
      await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
      // A failed Ctrl+S with the picker open: its toast under the header, and a drag across its words selects them where it stands.
      await composer.click();await page.keyboard.press("Control+A");await page.keyboard.type("Draft to stash",{delay:20});
      await picker.click();await expect(menu).toBeVisible();
      await page.keyboard.press("Control+s");await expect(alert).toHaveText(stashFailed);
      await expect.poll(()=>readErrorToast(page),{message:`the failed action's toast with the model picker open at ${width}x800 in ${mode}`}).toMatchObject({place:"under the header"});
      // The toast slides 8 px up into its place over 0.24 s (tb-toast-in), which the poll above can catch mid-slide: read it at rest.
      await alert.evaluate(async node=>{await Promise.all(node.getAnimations().map(animation=>animation.finished))});
      const before=await place(alert),box=await alert.boundingBox();
      await page.mouse.move(box.x+36,box.y+box.height/2);await page.mouse.down();
      await page.mouse.move(box.x+box.width-12,box.y+box.height/2,{steps:8});await page.mouse.up();
      expect(await page.evaluate(()=>String(window.getSelection())),`the words a drag across the failed action's toast selects at ${width}x800 in ${mode}`).toContain("stash or restore draft");
      expect(await place(alert),"the failed action's toast stays where the drag began").toBe(before);
      await expect(menu,"the picker stays open after a drag over a toast").toBeVisible();
      await page.screenshot({animations:"disabled",path:auditDir+`error-toast-selected-model-picker-${mode}-${width}x800.png`});
      await page.keyboard.press("Escape");await expect(menu).toHaveCount(0);
      await composer.click();await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");
    }
  }finally{await harness.close()}
});

// With the right panel maximized the undo toast stays at the window's foot, as with no menu open, while a / typed keeps its menu
// open behind the panel. A failed action's toast beside the undo toast took the place an open menu gives it under the undo toast,
// 52 px below the header with nothing above it. It keeps its place under the header there.
test("with the right panel maximized over an open / menu, a failed Ctrl+S's toast beside an archive's undo toast shows under the header, the undo toast at the window's foot",async({page})=>{
  test.setTimeout(120_000);
  const harness=await openComposerApp(page,{others:["Archive me A"]});await failStashes(page);
  try{
    const composer=page.getByTestId("composer"),alert=page.getByTestId("app-action-error"),slash=page.locator(".composer-wrap .slash-menu");
    const workspace=page.locator(".workspace-shell"),right=page.getByTestId("right-panel");
    // The error toast against its place under the header (the workspace shell's --tb-toast-top), the undo toast against the window's
    // foot, and whether the two lie apart.
    const readToasts=()=>page.evaluate(()=>{
      const shell=document.querySelector(".workspace-shell"),probe=document.createElement("div");
      probe.style.cssText="position:absolute;top:var(--tb-toast-top);height:0;visibility:hidden";shell.append(probe);
      const under=probe.getBoundingClientRect().top;probe.remove();
      const error=document.querySelector("[data-testid=app-action-error]").getBoundingClientRect(),undo=document.querySelector("[data-testid=thread-undo-toast]").getBoundingClientRect();
      const at=box=>`${Math.round(box.top)}-${Math.round(box.bottom)}`;
      return {error:Math.abs(error.top-under)<1?"under the header":`${at(error)}, ${Math.round(error.top-under)} px below its place under the header`,
        undo:Math.abs(innerHeight-24-undo.bottom)<1?"at the window's foot":at(undo),apart:error.bottom<=undo.top||undo.bottom<=error.top};
    });
    for(const [mode,width] of [["dark",1280],["light",900]]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);await page.setViewportSize({width,height:800});
      await expect(alert).toHaveCount(0,{timeout:10_000});
      await composer.click();await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");
      await page.keyboard.type("/",{delay:20});await expect(slash).toBeVisible();
      await page.getByTestId("right-panel-toggle").click();await expect(right).toBeVisible();
      await right.getByRole("button",{name:"Maximize right panel",exact:true}).click();await expect(workspace).toHaveClass(/right-maximized/);
      await archiveThread(page,"Archive me A");
      await page.keyboard.press("Control+s");await expect(alert).toHaveText(stashFailed);await expect(alert).toHaveClass(/with-thread-undo/);
      await expect.poll(readToasts,{message:`both toasts with the right panel maximized over the / menu at ${width}x800 in ${mode}`}).toEqual({error:"under the header",undo:"at the window's foot",apart:true});
      await page.screenshot({animations:"disabled",path:auditDir+`undo-and-error-toasts-maximized-panel-${mode}-${width}x800.png`});
      await undoArchive(page);await expect(threadRow(page,"Archive me A")).toHaveCount(1);
      await right.getByRole("button",{name:"Close right panel",exact:true}).click();await expect(right).toHaveCount(0);
      await expect(composer).toHaveValue("/");
    }
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

// What a person types straight on after Enter or Send, while the composer says Sending…, lands in the composer, which keeps the
// keyboard through the send: Send and Enter send none of it until the send has gone, as the line under the composer and Send's title
// say, and then it is the next message. The send waits on its repository context (a slow context packet) while hold is a gate not yet
// opened, and goes at once without one.
test("text typed straight on after Enter or Send while the composer says Sending… stays in the composer and is the next message once the send has gone",async({page})=>{
  test.setTimeout(120_000);
  const harness=await openComposerApp(page,{replies:[{text:"Reply number one."},{text:"Reply number two."},{text:"Reply number three."},{text:"Reply number four."}]});
  let hold=null;await page.route(/\/api\/context\/packet$/,async route=>{await hold?.promise;await route.fallback()});
  try{
    const composer=page.getByTestId("composer"),send=page.getByTestId("send"),reply=text=>page.getByText(text,{exact:true}),idle="Ask Trebell Code anything…";
    const waits=page.getByTestId("composer-sending"),waitsText=/^Sending.* · your draft stays here until the last message has gone\.$/;
    // Enter (dark), the send held: the next message typed straight on is in the composer, and Enter there sends nothing yet.
    hold=heldGate();
    await composer.click();await typeOn(page,"First message");await page.keyboard.press("Enter");await typeOn(page,"Second message");
    await expect(composer).toHaveAttribute("placeholder",/^Sending/);
    await expect(composer,"the keyboard while the send goes").toBeFocused();await expect(composer).toHaveValue("Second message");await expect(send).toBeDisabled();
    await expect(waits).toHaveText(waitsText);await expect(send).toHaveAttribute("title",/^Sending/);
    await page.keyboard.press("Enter");await expect(composer).toHaveValue("Second message");
    await shootHere(page,"typed-while-sending-after-enter");
    hold.open();
    await expect(reply("Reply number one.")).toBeVisible({timeout:15_000});await expect(composer).toHaveAttribute("placeholder",idle);await expect(waits).toHaveCount(0);
    await expect(composer,"the keyboard once the send has gone").toBeFocused();await expect(composer).toHaveValue("Second message");
    // Enter sends it, and what is typed straight on while that send goes at once lands there too.
    await page.keyboard.press("Enter");await typeOn(page,"Third message");
    await expect(reply("Reply number two.")).toBeVisible({timeout:15_000});await expect(composer).toHaveAttribute("placeholder",idle);
    await expect(composer).toBeFocused();await expect(composer).toHaveValue("Third message");
    // Send (light), held: the keyboard goes from Send, which turns off, to the composer, so what is typed straight on lands there.
    await switchMode(page,"light");
    hold=heldGate();
    await send.click();await typeOn(page,"Fourth message");
    await expect(composer).toHaveAttribute("placeholder",/^Sending/);
    await expect(composer,"the keyboard while the send from Send goes").toBeFocused();await expect(composer).toHaveValue("Fourth message");await expect(send).toBeDisabled();
    await expect(waits).toHaveText(waitsText);
    await shootHere(page,"typed-while-sending-after-send-button");
    hold.open();
    await expect(reply("Reply number three.")).toBeVisible({timeout:15_000});await expect(composer).toHaveAttribute("placeholder",idle);await expect(waits).toHaveCount(0);
    await expect(composer).toBeFocused();await expect(composer).toHaveValue("Fourth message");
    await send.click();await expect(reply("Reply number four.")).toBeVisible({timeout:15_000});await expect(composer).toHaveValue("");
    expect(sentTexts(harness)).toEqual(["Look at the login page","First message","Second message","Third message","Fourth message"]);
  }finally{hold?.open();await harness.close()}
});

// What a person adds to the composer while a send goes (Sending…), a screenshot pasted or a file attached with +, stays there once the
// send has gone and goes with the next message: only the files that went with the send leave the composer.
test("a screenshot pasted or a file attached while the composer says Sending… stays for the next message once the send has gone",async({page})=>{
  test.setTimeout(120_000);
  const harness=await openComposerApp(page,{replies:[{text:"Reply number one."},{text:"Reply number two."},{text:"Reply number three."},{text:"Reply number four."}]});
  let hold=null;await page.route(/\/api\/context\/packet$/,async route=>{await hold?.promise;await route.fallback()});
  try{
    const composer=page.getByTestId("composer"),sentFiles=page.locator(".user-bubble").last().locator(".user-attachments > span"),reply=text=>page.getByText(text,{exact:true});
    // Dark: a screenshot pasted while the first message goes stays on the shelf, and goes with the second.
    hold=heldGate();
    await composer.click();await typeOn(page,"First message");await page.keyboard.press("Enter");
    await expect(composer).toHaveAttribute("placeholder",/^Sending/);
    await pasteImage(page,"pasted-while-sending.png");await expect(chips(page)).toHaveText(["pasted-while-sending.png"]);
    hold.open();
    await expect(reply("Reply number one.")).toBeVisible({timeout:15_000});await expect(composer).toHaveAttribute("placeholder","Ask Trebell Code anything…");
    await expect(chips(page),"the screenshot pasted while the send went").toHaveText(["pasted-while-sending.png"]);
    await shootHere(page,"pasted-while-sending-kept");
    await typeOn(page,"Second message");await page.keyboard.press("Enter");
    await expect(reply("Reply number two.")).toBeVisible({timeout:15_000});
    await expect(sentFiles).toHaveText(["pasted-while-sending.png"]);await expect(chips(page)).toHaveCount(0);
    // Light: the file sent with the third message leaves the composer, and the one attached with + while it goes stays.
    await switchMode(page,"light");
    await chooseFiles(page,[{name:"sent-notes.txt",mimeType:"text/plain",buffer:Buffer.from("Notes sent with the third message.")}]);await expect(chips(page)).toHaveText(["sent-notes.txt"]);
    hold=heldGate();
    await composer.click();await typeOn(page,"Third message");await page.keyboard.press("Enter");
    await expect(composer).toHaveAttribute("placeholder",/^Sending/);
    await chooseFiles(page,[{name:"next-notes.txt",mimeType:"text/plain",buffer:Buffer.from("Notes for the next message.")}]);await expect(chips(page)).toHaveText(["sent-notes.txt","next-notes.txt"]);
    hold.open();
    await expect(reply("Reply number three.")).toBeVisible({timeout:15_000});await expect(composer).toHaveAttribute("placeholder","Ask Trebell Code anything…");
    await expect(chips(page),"the file attached while the send went").toHaveText(["next-notes.txt"]);
    await shootHere(page,"attached-while-sending-kept");
    await composer.click();await typeOn(page,"Fourth message");await page.keyboard.press("Enter");
    await expect(reply("Reply number four.")).toBeVisible({timeout:15_000});
    await expect(sentFiles).toHaveText(["next-notes.txt"]);await expect(chips(page)).toHaveCount(0);
    expect(sentTexts(harness)).toEqual(["Look at the login page","First message","Second message","Third message","Fourth message"]);
  }finally{hold?.open();await harness.close()}
});

// A send Stop ends while what the person typed on waits in the composer gives its draft back before that text, as a draft of its own:
// nothing failed and nothing ran in the background. It came back under a "recovered failed background draft" line, which went into
// the next message unless the person deleted it.
test("a send stopped while text typed on waits in the composer gives its draft back before that text, with no note",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page,{replies:[{text:"Reply number one."}]});
  let hold=null;await page.route(/\/api\/context\/packet$/,async route=>{await hold?.promise;await route.fallback()});
  try{
    const composer=page.getByTestId("composer"),stopButton=page.getByRole("button",{name:"Stop",exact:true});
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      hold=heldGate();
      await composer.click();await typeOn(page,"Fix the login bug");await page.keyboard.press("Enter");await typeOn(page,"and the signup page");
      await expect(composer).toHaveAttribute("placeholder",/^Sending/);await expect(composer).toHaveValue("and the signup page");
      await stopButton.click();hold.open();
      await expect(composer,"the draft back before what was typed on").toHaveValue("Fix the login bug\n\nand the signup page");
      await expect(composer).not.toHaveAttribute("placeholder",/^Sending/);await expect(page.getByTestId("composer-alert")).toHaveCount(0);
      await shootHere(page,"stopped-send-draft-before-typed");
      await composer.click();await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");await expect(composer).toHaveValue("");
    }
    expect(sentTexts(harness)).toEqual(["Look at the login page"]);
  }finally{hold?.open();await harness.close()}
});

// The draft leaves the composer as the send starts, before the send first waits (its files checked with the server, a running clone,
// a command such as /goal), so what the person types straight on lands there and is the next message, as the line under the composer
// says. The composer held the draft being sent, read-only, through each of those waits, and dropped every key typed, saying nothing.
test("text typed straight on while a send's files are checked lands in the composer and is the next message",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page,{replies:[{text:"Reply number one."},{text:"Reply number two."}]});
  let check=null;await page.route(/\/api\/attachments\/validate$/,async route=>{await check?.promise;await route.fallback()});
  try{
    const composer=page.getByTestId("composer"),waits=page.getByTestId("composer-sending"),files=text=>page.locator(".user-bubble").filter({hasText:text}).locator(".user-attachments > span");
    for(const [mode,answer] of [["dark","Reply number one."],["light","Reply number two."]]){
      await switchMode(page,mode);
      const note=mode+"-notes.txt",message=`Look at the ${mode} notes`,next=`Next ${mode} message`;
      await chooseFiles(page,[{name:note,mimeType:"text/plain",buffer:Buffer.from("Notes on the login page.")}]);await expect(chips(page)).toHaveText([note]);
      check=heldGate();
      await composer.click();await typeOn(page,message);await page.keyboard.press("Enter");await typeOn(page,next);
      await expect(composer).toHaveAttribute("placeholder",/^Sending/);
      await expect(composer,"what was typed while the files were checked").toHaveValue(next);await expect(composer).toBeFocused();
      await expect(waits).toHaveText(/^Sending.* · your draft stays here until the last message has gone\.$/);
      await shootHere(page,"typed-while-files-checked");
      check.open();
      await expect(files(message),"the message went with its file").toHaveText([note]);
      await expect(page.getByText(answer,{exact:true})).toBeVisible({timeout:15_000});await expect(composer).not.toHaveAttribute("placeholder",/^Sending/);
      await expect(composer,"what was typed is the next message").toHaveValue(next);await expect(chips(page)).toHaveCount(0);
      await composer.click();await page.keyboard.press("Control+A");await page.keyboard.press("Backspace");await expect(composer).toHaveValue("");
    }
    expect(sentTexts(harness)).toEqual(["Look at the login page","Look at the dark notes","Look at the light notes"]);
  }finally{check?.open();await harness.close()}
});

test("text typed straight on while /goal sets the thread's goal lands in the composer and stays once the goal is set",async({page})=>{
  test.setTimeout(90_000);
  const goalSet=heldGate();
  const harness=await openComposerApp(page,{hold:message=>message.method==="thread/goal/set"&&message.params?.objective?goalSet.promise:null});
  try{
    const composer=page.getByTestId("composer"),panel=page.getByTestId("goal-panel"),objective="Make the login page load in a second";
    await composer.click();await typeOn(page,"/goal "+objective);await page.keyboard.press("Enter");await typeOn(page,"Then check the signup page");
    await expect(composer,"what was typed while /goal ran").toHaveValue("Then check the signup page");await expect(composer).toBeFocused();
    await shootHere(page,"typed-while-goal-is-set");
    await switchMode(page,"light");await shootHere(page,"typed-while-goal-is-set");
    goalSet.open();
    await expect(panel.getByLabel("Objective",{exact:true})).toHaveValue(objective);
    await expect(composer,"what was typed stays once the goal is set").toHaveValue("Then check the signup page");
  }finally{goalSet.open();await harness.close()}
});
