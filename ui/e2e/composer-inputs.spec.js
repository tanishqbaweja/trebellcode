import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { replyItem,routeRelayApp,startRelayHarness } from "./relay-history-harness.js";

// What a person puts into the composer besides typed text (files, slash commands, dictation, the welcome suggestions), over a
// Trebell Native thread on the real agent relay. Attachments go to the GUI server as they do in the app.
const auditDir=fileURLToPath(new URL("../../visual-audit/composer-inputs/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

// One thread, "Composer thread", open, unless newTask leaves the window on New task. replies answers the provider's calls in order.
// refuse(message), when given, names an error to answer a request with instead of the relay (a harness refusing it).
async function openComposerApp(page,{newTask=false,replies=[],refuse=null}={}){
  const harness=await startRelayHarness({replies});
  harness.seedThread("Composer thread",[{user:"Look at the login page",items:[replyItem("seed-reply-1","The login page renders.")]}]);
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
