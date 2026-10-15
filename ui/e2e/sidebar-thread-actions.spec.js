import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replyItem,routeRelayApp,startRelayHarness } from "./relay-history-harness.js";

// The sidebar's bulk actions and the Snooze dialog over Trebell Native threads on the real agent relay, with a proxy on the page's
// socket that refuses what a test names (a harness refusing a thread's move or archive).
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
const names=["Bulk one","Bulk two","Bulk three","Bulk four"];

// refuse(message) names an error to answer a request with instead of the relay. stop() stops the harness as far as the page can
// tell: its socket closes and every reconnect is turned away.
async function proxyRelay(page,harness){
  const proxy={refuse:()=>null,stopped:false,sockets:[]};
  await page.routeWebSocket(harness.wsUrl,ws=>{
    if(proxy.stopped){ws.close({code:1011,reason:"harness stopped"});return}
    const server=ws.connectToServer();proxy.sockets.push(ws);
    ws.onMessage(message=>{
      let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
      const refusal=parsed?.id!=null&&parsed.method?proxy.refuse(parsed):null;
      if(refusal){ws.send(JSON.stringify({id:parsed.id,error:{code:-32000,message:refusal}}));return}
      server.send(message);
    });
  });
  proxy.stop=()=>{proxy.stopped=true;for(const ws of proxy.sockets.splice(0))ws.close({code:1011,reason:"harness stopped"})};
  return proxy;
}

// The threads in list (the four Bulk ones unless given), a minute apart, with the first open. meta is what Trebell keeps of each
// thread (its snooze time among it), as the GUI server keeps it.
async function openSidebarApp(page,list=names){
  const harness=await startRelayHarness();
  for(const name of list)harness.seedThread(name,[{user:"Work on "+name.toLowerCase(),items:[replyItem("seed-reply-"+harness.threads.length,"Done with "+name.toLowerCase()+".")]}]);
  const base=Math.floor(Date.now()/1000)-3600;harness.threads.forEach((thread,index)=>harness.threadStore.update(thread.id,{updatedAt:base-index*60},{touch:false}));
  await routeRelayApp(page,harness);
  const meta=Object.fromEntries(harness.threads.map(thread=>[thread.id,{projectless:false,environmentId:null,cwd:harness.repo,runtime:"native",runtimeInstanceId:"native-default"}]));
  await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>{
    const request=route.request(),body=request.method()==="POST"?request.postDataJSON()||{}:{},id=String(body.threadId||new URL(request.url()).searchParams.get("threadId")||"");
    if(request.method()==="POST")meta[id]={...(meta[id]||{}),...(body.patch||{})};
    return json(route,meta[id]||{});
  });
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  const proxy=await proxyRelay(page,harness);
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  await expect.poll(()=>groups(page)).toEqual([["Active",list]]);
  const row=threadRow(page,list[0]);await row.locator(".thread-main").click();
  await expect(row).toHaveClass(/active/);await expect(page.getByTestId("composer")).not.toHaveAttribute("placeholder","Opening thread…");
  const id=name=>harness.threads.find(thread=>thread.name===name).id;
  return {harness,proxy,meta,id};
}
const groups=page=>page.locator(".thread-sections section").evaluateAll(sections=>sections.map(section=>[section.querySelector("h4 .thread-group-name").textContent,[...section.querySelectorAll(".thread-main")].map(node=>node.title)]));
const threadRow=(page,name)=>page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});
const selected=page=>page.locator(".thread-row").evaluateAll(rows=>rows.filter(row=>row.querySelector(".thread-select")?.checked).map(row=>row.querySelector(".thread-main").title));
const bulkBar=page=>page.locator(".bulk-bar");
const undoToast=page=>page.getByTestId("thread-undo-toast");
const sidebarAlert=page=>page.locator(".sidebar .sidebar-action-error");
const snoozeDialog=page=>page.getByRole("dialog",{name:/^Snooze/});
// Thread actions opens bulk mode with the first thread ticked; a person ticks the others in turn.
async function selectThreads(page,list){
  await page.getByRole("button",{name:"Thread actions",exact:true}).click();
  await expect(page.locator(".thread-select").first()).toBeVisible();
  for(const name of list)if(!(await selected(page)).includes(name))await threadRow(page,name).locator(".thread-select").click();
  for(const name of await selected(page))if(!list.includes(name))await threadRow(page,name).locator(".thread-select").click();
  await expect(bulkBar(page).locator("span")).toHaveText(list.length+" selected");
}
async function rowMenu(page,name){
  const row=threadRow(page,name);await row.hover();await row.locator(".thread-menu summary").click();
  await expect(row.locator(".thread-menu")).toHaveAttribute("open","");return row;
}
// The header's theme button, as a person switches between dark and light, and the window at 1280x800 and 900x800 in that mode.
async function switchMode(page,mode){
  const html=page.locator("html");if(await html.getAttribute("data-mode")===mode)return;
  await page.getByTestId("appearance-toggle").first().click();await expect(html).toHaveAttribute("data-mode",mode);
}
async function shoot(page,name){
  const mode=await page.locator("html").getAttribute("data-mode");
  for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-"+width+"x800.png"})}
  await page.setViewportSize({width:1280,height:800});
}

test("a bulk Pin or Archive tries every thread, says which one failed and why, offers Undo for the rest and keeps the failed one selected",async({page})=>{
  test.setTimeout(120_000);
  const {harness,proxy,id}=await openSidebarApp(page);
  try{
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      // The harness refuses to move Bulk two; Bulk one and Bulk three, before and after it, are pinned all the same.
      proxy.refuse=message=>message.method==="thread/section/move"&&message.params?.threadId===id("Bulk two")?"Second pin refused":null;
      await selectThreads(page,["Bulk one","Bulk two","Bulk three"]);
      await bulkBar(page).getByRole("button",{name:"Pin",exact:true}).click();
      await expect(sidebarAlert(page)).toHaveText("Could not pin “Bulk two”: Second pin refused.");
      await expect.poll(()=>groups(page)).toEqual([["Pinned",["Bulk one","Bulk three"]],["Active",["Bulk two","Bulk four"]]]);
      await expect(undoToast(page)).toContainText("2 threads pinned");
      await expect(bulkBar(page).locator("span")).toHaveText("1 selected");expect(await selected(page)).toEqual(["Bulk two"]);
      await shoot(page,"sidebar-bulk-pin-partial");
      // Undo puts back the two it pinned.
      await undoToast(page).getByRole("button",{name:"Undo",exact:true}).click();
      await expect.poll(()=>groups(page)).toEqual([["Active",names]]);
      proxy.refuse=()=>null;
      await page.getByRole("button",{name:"Thread actions",exact:true}).click();await expect(bulkBar(page)).toHaveCount(0);
    }
    await switchMode(page,"dark");
    // Archive: the harness refuses Bulk three, the last one tried; the others are archived, and Undo brings them back.
    proxy.refuse=message=>message.method==="thread/archive"&&message.params?.threadId===id("Bulk three")?"Archive is read-only":null;
    await selectThreads(page,["Bulk two","Bulk three","Bulk four"]);
    await bulkBar(page).getByRole("button",{name:"Archive",exact:true}).click();
    await expect(sidebarAlert(page)).toHaveText("Could not archive “Bulk three”: Archive is read-only.");
    await expect.poll(()=>groups(page)).toEqual([["Active",["Bulk one","Bulk three"]]]);
    await expect(undoToast(page)).toContainText("2 threads archived");
    expect(await selected(page)).toEqual(["Bulk three"]);
    proxy.refuse=()=>null;
    await undoToast(page).getByRole("button",{name:"Undo",exact:true}).click();
    await expect.poll(()=>groups(page)).toEqual([["Active",names]]);
    expect(harness.threadStore.list("native").filter(thread=>thread.archived).length).toBe(0);
  }finally{await harness.close()}
});

test("a bulk Snooze the harness refuses for one thread snoozes the rest with Undo, and the dialog stays on the refused one with the reason",async({page})=>{
  test.setTimeout(90_000);
  const {harness,proxy,meta,id}=await openSidebarApp(page);
  try{
    proxy.refuse=message=>message.method==="thread/section/move"&&message.params?.threadId===id("Bulk three")&&message.params?.sectionId?"Sections are read-only":null;
    await selectThreads(page,["Bulk two","Bulk three","Bulk four"]);
    await bulkBar(page).getByRole("button",{name:"Snooze",exact:true}).click();
    const dialog=snoozeDialog(page);await expect(dialog).toBeVisible();await expect(dialog.locator("#snooze-dialog-title")).toHaveText("Snooze 3 threads");
    await dialog.getByRole("button",{name:"Snooze",exact:true}).click();
    await expect(dialog.getByRole("alert")).toHaveText("Could not snooze “Bulk three”: Sections are read-only.");
    await expect(dialog.locator("#snooze-dialog-title")).toHaveText("Snooze thread");
    await expect.poll(()=>groups(page)).toEqual([["Active",["Bulk one","Bulk three"]],["Snoozed",["Bulk two","Bulk four"]]]);
    await expect(undoToast(page)).toContainText("2 threads snoozed");
    expect(await selected(page)).toEqual(["Bulk three"]);
    // The refused thread keeps no wake time.
    expect(meta[id("Bulk three")].snoozedUntil??null).toBe(null);expect(Number(meta[id("Bulk two")].snoozedUntil)).toBeGreaterThan(Date.now());
    for(const mode of ["dark","light"]){
      if(mode==="light"){await dialog.getByRole("button",{name:"Cancel",exact:true}).click();await switchMode(page,"light");await bulkBar(page).getByRole("button",{name:"Snooze",exact:true}).click();await dialog.getByRole("button",{name:"Snooze",exact:true}).click();await expect(dialog.getByRole("alert")).toHaveText("Could not snooze “Bulk three”: Sections are read-only.")}
      await shoot(page,"sidebar-bulk-snooze-partial");
    }
    // Retried once the harness takes it, the dialog snoozes the one left and closes.
    proxy.refuse=()=>null;
    await dialog.getByRole("button",{name:"Snooze",exact:true}).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(()=>groups(page)).toEqual([["Active",["Bulk one"]],["Snoozed",["Bulk two","Bulk three","Bulk four"]]]);
    await expect(bulkBar(page)).toHaveCount(0);
  }finally{await harness.close()}
});

test("a refused Snooze says why in the dialog, leaves the thread as it was and writes nothing in the open thread",async({page})=>{
  test.setTimeout(90_000);
  const {harness,proxy,meta,id}=await openSidebarApp(page);
  try{
    proxy.refuse=message=>message.method==="thread/section/move"?"Sections are read-only":null;
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      const row=await rowMenu(page,"Bulk three");
      await row.getByRole("button",{name:"Snooze…",exact:true}).click();
      const dialog=snoozeDialog(page);await expect(dialog).toBeVisible();
      await dialog.getByRole("button",{name:"Snooze",exact:true}).click();
      await expect(dialog.getByRole("alert")).toHaveText("Could not snooze “Bulk three”: Sections are read-only.");
      await expect(dialog).toBeVisible();
      await shoot(page,"sidebar-snooze-refused");
      await dialog.getByRole("button",{name:"Cancel",exact:true}).click();await expect(dialog).toHaveCount(0);
    }
    // Bulk three is as it was: in Active, with no wake time saved, and the open thread's conversation says nothing of it.
    await expect.poll(()=>groups(page)).toEqual([["Active",names]]);
    expect(meta[id("Bulk three")].snoozedUntil??null).toBe(null);
    await expect(page.locator(".conversation-column").getByText("Sections are read-only")).toHaveCount(0);
    await expect(threadRow(page,"Bulk three").locator(".thread-main > div > span")).not.toHaveText(/Wakes/);
  }finally{await harness.close()}
});

test("closing the Snooze dialog with Cancel, Escape or its close button gives focus back to the control that opened it",async({page})=>{
  test.setTimeout(90_000);
  const {harness}=await openSidebarApp(page);
  const dialog=snoozeDialog(page);
  try{
    for(const [close,mode] of [["Cancel","dark"],["Escape","dark"],["Escape","light"],["Close snooze dialog","light"]]){
      await switchMode(page,mode);
      const row=await rowMenu(page,"Bulk two"),button=row.locator(".thread-menu summary");
      await row.getByRole("button",{name:"Snooze…",exact:true}).click();
      await expect(dialog).toBeVisible();await expect(dialog.getByLabel("Snooze duration")).toBeFocused();
      if(close==="Escape")await page.keyboard.press("Escape");else await dialog.getByRole("button",{name:close,exact:true}).click();
      await expect(dialog).toHaveCount(0);
      await expect(button).toBeFocused();await expect(row.locator(".thread-menu")).not.toHaveAttribute("open","");
      if(close==="Escape"){await shoot(page,"sidebar-snooze-closed-focus");await expect(button).toBeFocused()}
    }
    await switchMode(page,"dark");
    // From the keyboard: Enter on the row's menu button, Tab to Snooze…, Enter, then Escape lands back on the button.
    const row=threadRow(page,"Bulk three"),button=row.locator(".thread-menu summary");
    await row.locator(".thread-main").focus();await page.keyboard.press("Tab");await expect(button).toBeFocused();
    await page.keyboard.press("Enter");await expect(row.locator(".thread-menu")).toHaveAttribute("open","");
    await page.keyboard.press("Tab");await page.keyboard.press("Tab");await expect(row.getByRole("button",{name:"Snooze…",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(button).toBeFocused();
    // The bulk bar's Snooze gets it back too.
    await selectThreads(page,["Bulk one","Bulk four"]);
    const bulkSnooze=bulkBar(page).getByRole("button",{name:"Snooze",exact:true});
    await bulkSnooze.click();await expect(dialog).toBeVisible();
    await dialog.getByRole("button",{name:"Cancel",exact:true}).click();await expect(dialog).toHaveCount(0);
    await expect(bulkSnooze).toBeFocused();
  }finally{await harness.close()}
});

test("a bulk Archive the harness refuses for every thread says its reason once and keeps the threads in view",async({page})=>{
  test.setTimeout(120_000);
  const list=Array.from({length:10},(_,index)=>"Payments refactor step "+String(index+1).padStart(2,"0")+" with the refund flow");
  const {harness,proxy}=await openSidebarApp(page,list);
  try{
    proxy.refuse=message=>message.method==="thread/archive"?"Archive is read-only":null;
    await selectThreads(page,list);
    await bulkBar(page).getByRole("button",{name:"Archive",exact:true}).click();
    const alert=sidebarAlert(page);
    await expect(alert).toHaveText("Could not archive 10 threads: Archive is read-only.");
    expect(await selected(page)).toEqual(list);
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});
        // The threads still selected show under the alert, which takes a line or two of the sidebar: the list stays where the
        // person left it, at the last ones ticked.
        await expect(threadRow(page,list[9])).toBeInViewport();await expect(threadRow(page,list[8])).toBeInViewport();
        const [box,sidebar]=await Promise.all([alert.boundingBox(),page.locator(".sidebar").boundingBox()]);
        expect(box.height).toBeLessThan(sidebar.height/8);
        await page.screenshot({animations:"disabled",path:auditDir+"sidebar-bulk-archive-all-refused-"+mode+"-"+width+"x800.png"});
      }
      await page.setViewportSize({width:1280,height:800});
    }
  }finally{await harness.close()}
});

test("with the harness away, a bulk Pin and a Snooze say they could not, offer no Undo and leave the threads as they were",async({page})=>{
  test.setTimeout(90_000);
  const {harness,proxy,meta,id}=await openSidebarApp(page);
  try{
    proxy.stop();
    await expect(page.getByTestId("composer-transport")).toContainText("Trebell Native");
    await selectThreads(page,["Bulk two","Bulk three"]);
    await bulkBar(page).getByRole("button",{name:"Pin",exact:true}).click();
    await expect(sidebarAlert(page)).toHaveText("Could not pin 2 threads: Trebell Native is not connected.");
    await expect.poll(()=>groups(page)).toEqual([["Active",names]]);
    await expect(undoToast(page)).toHaveCount(0);
    expect(await selected(page)).toEqual(["Bulk two","Bulk three"]);
    for(const mode of ["dark","light"]){await switchMode(page,mode);await shoot(page,"sidebar-bulk-pin-harness-away")}
    await switchMode(page,"dark");
    // Archive says the same.
    await bulkBar(page).getByRole("button",{name:"Archive",exact:true}).click();
    await expect(sidebarAlert(page)).toHaveText("Could not archive 2 threads: Trebell Native is not connected.");
    await expect.poll(()=>groups(page)).toEqual([["Active",names]]);
    await page.getByRole("button",{name:"Thread actions",exact:true}).click();await expect(bulkBar(page)).toHaveCount(0);
    // A Snooze from the row's menu: the dialog stays and says why, and no wake time is kept.
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      const row=await rowMenu(page,"Bulk three");
      await row.getByRole("button",{name:"Snooze…",exact:true}).click();
      const dialog=snoozeDialog(page);await expect(dialog).toBeVisible();
      await dialog.getByRole("button",{name:"Snooze",exact:true}).click();
      await expect(dialog.getByRole("alert")).toHaveText("Could not snooze “Bulk three”: Trebell Native is not connected.");
      await expect(dialog).toBeVisible();await expect(undoToast(page)).toHaveCount(0);
      await shoot(page,"sidebar-snooze-harness-away");
      await dialog.getByRole("button",{name:"Cancel",exact:true}).click();await expect(dialog).toHaveCount(0);
    }
    await expect.poll(()=>groups(page)).toEqual([["Active",names]]);
    expect(meta[id("Bulk three")].snoozedUntil??null).toBe(null);
  }finally{await harness.close()}
});

test("a bulk Pin that pins one of the threads offers Undo for “Thread pinned”",async({page})=>{
  test.setTimeout(60_000);
  const {harness,proxy,id}=await openSidebarApp(page);
  try{
    proxy.refuse=message=>message.method==="thread/section/move"&&message.params?.threadId===id("Bulk two")?"Second pin refused":null;
    await selectThreads(page,["Bulk one","Bulk two"]);
    await bulkBar(page).getByRole("button",{name:"Pin",exact:true}).click();
    await expect(sidebarAlert(page)).toHaveText("Could not pin “Bulk two”: Second pin refused.");
    await expect.poll(()=>groups(page)).toEqual([["Pinned",["Bulk one"]],["Active",["Bulk two","Bulk three","Bulk four"]]]);
    await expect(undoToast(page).locator("span").first()).toHaveText("Thread pinned");
    for(const mode of ["dark","light"]){await switchMode(page,mode);await shoot(page,"sidebar-bulk-pin-one-of-two")}
  }finally{await harness.close()}
});

test("a bulk action that changes every selected thread leaves keyboard focus on Thread actions as the bulk bar goes",async({page})=>{
  test.setTimeout(60_000);
  const {harness}=await openSidebarApp(page);
  try{
    const toggle=page.getByRole("button",{name:"Thread actions",exact:true});
    // Two threads pinned in each mode, from the bar's Pin by the keyboard.
    for(const [mode,pair,after] of [["dark",["Bulk two","Bulk three"],[["Pinned",["Bulk two","Bulk three"]],["Active",["Bulk one","Bulk four"]]]],["light",["Bulk one","Bulk four"],null]]){
      await switchMode(page,mode);
      await selectThreads(page,pair);
      await bulkBar(page).getByRole("button",{name:"Pin",exact:true}).focus();await page.keyboard.press("Enter");
      if(after)await expect.poll(()=>groups(page)).toEqual(after);else await expect.poll(async()=>(await groups(page)).map(([name])=>name)).toEqual(["Pinned"]);
      await expect(bulkBar(page)).toHaveCount(0);
      await expect(toggle).toBeFocused();
      await shoot(page,"sidebar-bulk-done-focus");
    }
    // From there a person carries on from the keyboard: Enter opens bulk mode again.
    await page.keyboard.press("Enter");await expect(bulkBar(page)).toBeVisible();
  }finally{await harness.close()}
});

test("Delete asks in the app's own dialog, never the browser's: Escape and Cancel keep the thread, and Delete thread removes it from the keyboard",async({page})=>{
  test.setTimeout(90_000);
  const nativeDialogs=[];page.on("dialog",dialog=>{nativeDialogs.push(dialog.type()+": "+dialog.message());dialog.dismiss().catch(()=>{})});
  const {harness,id}=await openSidebarApp(page);
  const question=page.locator("dialog.inspector-text-prompt"),doomed=id("Bulk three");
  try{
    for(const [mode,close] of [["dark","Escape"],["light","Cancel"]]){
      await switchMode(page,mode);
      const row=await rowMenu(page,"Bulk three");
      await row.getByRole("button",{name:"Delete",exact:true}).click();
      await expect(question.locator("p")).toHaveText("Delete “Bulk three” permanently? This cannot be undone.");
      await expect(question.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
      await expect(question.getByRole("button",{name:"Delete thread",exact:true})).toBeVisible();
      await shoot(page,"sidebar-delete-question");
      if(close==="Escape")await page.keyboard.press("Escape");else await question.getByRole("button",{name:"Cancel",exact:true}).click();
      await expect(question).toHaveCount(0);
      await expect(row.locator(".thread-menu summary")).toBeFocused();await expect(row).toBeVisible();
    }
    expect(harness.threadStore.get(doomed)).toBeTruthy();
    // From the keyboard: Enter on the row's menu button, Tab down to Delete, Enter, Tab from Cancel to Delete thread, Enter. Focus
    // then goes to the row after the deleted one, or the one before for the last row, so the keyboard keeps its place in the list.
    const deleteFromKeyboard=async name=>{
      const row=threadRow(page,name),button=row.locator(".thread-menu summary"),remove=row.getByRole("button",{name:"Delete",exact:true});
      await row.locator(".thread-main").focus();await page.keyboard.press("Tab");await expect(button).toBeFocused();
      await page.keyboard.press("Enter");await expect(row.locator(".thread-menu")).toHaveAttribute("open","");
      for(let step=0;step<14&&!await remove.evaluate(node=>node===document.activeElement);step++)await page.keyboard.press("Tab");
      await expect(remove).toBeFocused();await page.keyboard.press("Enter");
      await expect(question.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();
      await page.keyboard.press("Tab");await expect(question.getByRole("button",{name:"Delete thread",exact:true})).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(question).toHaveCount(0);
    };
    await switchMode(page,"dark");
    await deleteFromKeyboard("Bulk three");
    await expect.poll(()=>groups(page)).toEqual([["Active",["Bulk one","Bulk two","Bulk four"]]]);
    expect(harness.threadStore.get(doomed)).toBeFalsy();
    await expect(threadRow(page,"Bulk four").locator(".thread-main"),"focus after the delete").toBeFocused();
    await shoot(page,"sidebar-delete-focus-next-row");
    await switchMode(page,"light");
    await deleteFromKeyboard("Bulk four");
    await expect.poll(()=>groups(page)).toEqual([["Active",["Bulk one","Bulk two"]]]);
    await expect(threadRow(page,"Bulk two").locator(".thread-main"),"focus after the last row's delete").toBeFocused();
    await shoot(page,"sidebar-delete-focus-next-row");
    expect(nativeDialogs).toEqual([]);
  }finally{await harness.close()}
});

test("a double click on Delete asks once with the keyboard on Cancel, so Enter keeps the thread",async({page})=>{
  test.setTimeout(60_000);
  const {harness,id}=await openSidebarApp(page);
  const question=page.locator("dialog.inspector-text-prompt"),cancel=question.getByRole("button",{name:"Cancel",exact:true});
  try{
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      const row=await rowMenu(page,"Bulk three");
      // The question opens on the first click, so the second lands on its backdrop, where Delete was.
      await row.getByRole("button",{name:"Delete",exact:true}).dblclick();
      await expect(question).toHaveCount(1);await expect(cancel).toBeFocused();
      await shoot(page,"sidebar-delete-double-click");
      await page.keyboard.press("Enter");
      await expect(question).toHaveCount(0);await expect(row).toBeVisible();
    }
    await expect.poll(()=>groups(page)).toEqual([["Active",names]]);
    expect(harness.threadStore.get(id("Bulk three"))).toBeTruthy();
  }finally{await harness.close()}
});

test("a double click on Pin or Archive in another thread's menu runs it once, and its second click opens nothing that lay under the menu",async({page})=>{
  test.setTimeout(90_000);
  const list=["Alpha task","Beta task","Gamma task","Delta task","Epsilon task"];
  const {harness,proxy,id}=await openSidebarApp(page,list);
  const title=page.locator(".chat-workspace .workspace-header .thread-title-button"),opened=[];
  try{
    const gamma=threadRow(page,"Gamma task");await gamma.locator(".thread-main").click();
    await expect(gamma).toHaveClass(/active/);await expect(title).toContainText("Gamma task");
    // A thread the second click opened would be resumed on the harness.
    proxy.refuse=message=>{if(message.method==="thread/resume"&&message.params?.threadId!==id("Gamma task"))opened.push(message.params?.threadId);return null};
    // Gamma stays open: its row, its conversation, no other page or panel and no bulk mode.
    const gammaStaysOpen=async()=>{
      await expect(page.locator(".thread-row.active .thread-main")).toHaveAttribute("title","Gamma task");
      await expect(title).toContainText("Gamma task");await expect(page.getByTestId("composer")).toBeVisible();
      await expect(page.locator(".sidebar-utility[aria-current=page],.sidebar-utility[aria-pressed=true]")).toHaveCount(0);
      await expect(bulkBar(page)).toHaveCount(0);expect(opened).toEqual([]);
    };
    // The first click runs the item and closes the menu, so the second lands where the item was: on the row below for Pin, on
    // the sidebar's destinations for Archive.
    for(const [mode,pin,archive] of [["dark","Delta task","Alpha task"],["light","Epsilon task","Beta task"]]){
      await switchMode(page,mode);
      let row=await rowMenu(page,pin);
      await row.getByRole("button",{name:"Pin",exact:true}).dblclick();
      await expect(undoToast(page).locator("span").first()).toHaveText("Thread pinned");
      await expect.poll(async()=>(await groups(page)).find(([name])=>name==="Pinned")?.[1]||[]).toContain(pin);
      await gammaStaysOpen();
      row=await rowMenu(page,archive);
      await row.getByRole("button",{name:"Archive",exact:true}).dblclick();
      await expect(undoToast(page).locator("span").first()).toHaveText("Thread archived");
      await expect(threadRow(page,archive)).toHaveCount(0);
      await gammaStaysOpen();
      await shoot(page,"sidebar-row-menu-double-click");
    }
    await expect.poll(async()=>(await groups(page)).find(([name])=>name==="Active")?.[1]).toEqual(["Gamma task"]);
    expect(harness.threadStore.list("native").filter(thread=>thread.archived).map(thread=>thread.name).sort()).toEqual(["Alpha task","Beta task"]);
  }finally{await harness.close()}
});

test("Enter held on Pin or Settle in a row's menu runs it once, and its repeats open nothing that took the keyboard",async({page})=>{
  test.setTimeout(60_000);
  const {harness,proxy,id}=await openSidebarApp(page);
  const title=page.locator(".chat-workspace .workspace-header .thread-title-button"),opened=[];
  proxy.refuse=message=>{if(message.method==="thread/resume"&&message.params?.threadId!==id("Bulk one"))opened.push(message.params?.threadId);return null};
  const frames=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  try{
    for(const [mode,name,item,group] of [["dark","Bulk two","Pin","Pinned"],["light","Bulk three","Settle","Settled"]]){
      await switchMode(page,mode);
      // Tab from the row to its menu button, Enter opens the menu, Tab goes down to the item, and Enter is held on it.
      const row=threadRow(page,name),target=row.getByRole("button",{name:item,exact:true});
      await row.locator(".thread-main").focus();await page.keyboard.press("Tab");await page.keyboard.press("Enter");
      await expect(row.locator(".thread-menu")).toHaveAttribute("open","");
      for(let step=0;step<14&&!await target.evaluate(node=>node===document.activeElement);step++)await page.keyboard.press("Tab");
      await expect(target).toBeFocused();
      await page.keyboard.down("Enter");
      await expect.poll(async()=>(await groups(page)).find(([section])=>section===group)?.[1]||[]).toContain(name);
      // The thread went to its group and the keyboard to the row after it, where the repeats land.
      for(let repeat=0;repeat<6;repeat++)await page.keyboard.down("Enter");
      await page.keyboard.up("Enter");await frames();
      await expect(page.locator(".thread-row.active .thread-main")).toHaveAttribute("title","Bulk one");
      await expect(title).toContainText("Bulk one");expect(opened).toEqual([]);
      await shoot(page,"sidebar-row-menu-held-enter");
    }
  }finally{await harness.close()}
});

test("Escape on an item of a row's menu closes the menu with the keyboard back on its Thread actions button",async({page})=>{
  test.setTimeout(60_000);
  const {harness}=await openSidebarApp(page);
  try{
    const row=threadRow(page,"Bulk two"),button=row.locator(".thread-menu summary"),menu=row.locator(".thread-menu");
    for(const [mode,item] of [["dark","Pin"],["dark","Archive"],["light","Pin"]]){
      await switchMode(page,mode);
      // Tab from the row to its menu button, Enter opens the menu, Tab goes down to the item, and Escape closes the menu.
      await row.locator(".thread-main").focus();await page.keyboard.press("Tab");await expect(button).toBeFocused();
      await page.keyboard.press("Enter");await expect(menu).toHaveAttribute("open","");
      const target=row.getByRole("button",{name:item,exact:true});
      for(let step=0;step<14&&!await target.evaluate(node=>node===document.activeElement);step++)await page.keyboard.press("Tab");
      await expect(target).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).not.toHaveAttribute("open","");await expect(row.locator(".thread-menu-popover")).toBeHidden();
      await expect(button).toBeFocused();await expect(button).toBeVisible();
      if(item==="Pin")await shoot(page,"sidebar-row-menu-escape-from-item");
      // The keyboard carries on from the button: Enter opens the menu again, and Escape closes it there.
      await page.keyboard.press("Enter");await expect(menu).toHaveAttribute("open","");
      await page.keyboard.press("Escape");await expect(menu).not.toHaveAttribute("open","");await expect(button).toBeFocused();
    }
    await expect.poll(()=>groups(page)).toEqual([["Active",names]]);
  }finally{await harness.close()}
});

test("with the harness away, Delete says Trebell Native is not connected before it asks, and the open thread stays open and listed",async({page})=>{
  test.setTimeout(90_000);
  const {harness,proxy,id}=await openSidebarApp(page);
  const question=page.locator("dialog.inspector-text-prompt");
  try{
    proxy.stop();
    await expect(page.getByTestId("composer-transport")).toContainText("Trebell Native");
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      const row=await rowMenu(page,"Bulk one");
      await row.getByRole("button",{name:"Delete",exact:true}).click();
      await expect(sidebarAlert(page)).toHaveText("Trebell Native is not connected");
      await expect(question).toHaveCount(0);
      await expect(threadRow(page,"Bulk one")).toHaveClass(/active/);
      await expect.poll(()=>groups(page)).toEqual([["Active",names]]);
      await shoot(page,"sidebar-delete-harness-away");
    }
    expect(harness.threadStore.get(id("Bulk one"))).toBeTruthy();
  }finally{await harness.close()}
});

test("a Delete the harness refuses names the thread with its reason, from the mouse and from the keyboard, and keeps it listed",async({page})=>{
  test.setTimeout(90_000);
  const {harness,proxy,id}=await openSidebarApp(page);
  const question=page.locator("dialog.inspector-text-prompt"),row=threadRow(page,"Bulk three"),remove=row.getByRole("button",{name:"Delete",exact:true});
  const confirm=question.getByRole("button",{name:"Delete thread",exact:true});
  try{
    proxy.refuse=message=>message.method==="thread/delete"?"Thread store is read-only":null;
    // Clicked in dark. In light the keyboard goes from the row to its menu button, Enter, down to Delete, Enter, then from Cancel
    // to Delete thread, Enter.
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      if(mode==="dark"){await rowMenu(page,"Bulk three");await remove.click()}
      else{
        await row.locator(".thread-main").focus();await page.keyboard.press("Tab");await page.keyboard.press("Enter");
        await expect(row.locator(".thread-menu")).toHaveAttribute("open","");
        for(let step=0;step<14&&!await remove.evaluate(node=>node===document.activeElement);step++)await page.keyboard.press("Tab");
        await expect(remove).toBeFocused();await page.keyboard.press("Enter");
      }
      // The question is open, and the last refusal's message went as the Delete was chosen.
      await expect(question.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();await expect(sidebarAlert(page)).toHaveCount(0);
      if(mode==="dark")await confirm.click();else{await page.keyboard.press("Tab");await expect(confirm).toBeFocused();await page.keyboard.press("Enter")}
      await expect(question).toHaveCount(0);
      await expect(sidebarAlert(page)).toHaveText("Could not delete “Bulk three”: Thread store is read-only.");
      await expect(row).toBeVisible();await expect(threadRow(page,"Bulk one")).toHaveClass(/active/);
      await shoot(page,"sidebar-delete-refused");
    }
    await expect.poll(()=>groups(page)).toEqual([["Active",names]]);
    expect(harness.threadStore.get(id("Bulk three"))).toBeTruthy();
  }finally{await harness.close()}
});
