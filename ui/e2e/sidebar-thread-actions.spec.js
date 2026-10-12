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
