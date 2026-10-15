import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replyItem,routeRelayApp,startRelayHarness } from "./relay-history-harness.js";

// The workspace header over a Trebell Native thread on the real agent relay, with the provider scripted: the project crumb, the
// thread title (Rename), the branch button and Review.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
function gate(){let open=()=>{};const promise=new Promise(resolve=>{open=resolve});return {promise,open}}

// The page's socket to the relay goes through this proxy: refuse(message) names an error to answer a request with instead of the
// relay, and answer(message) a result. stop() stops the harness as far as the page can tell (its socket closes and every reconnect
// is turned away) until start().
async function proxyRelay(page,harness){
  const proxy={refuse:()=>null,answer:()=>undefined,stopped:false,sockets:[]};
  await page.routeWebSocket(harness.wsUrl,ws=>{
    if(proxy.stopped){ws.close({code:1011,reason:"harness stopped"});return}
    const server=ws.connectToServer();proxy.sockets.push(ws);
    ws.onMessage(message=>{
      let parsed=null;try{parsed=JSON.parse(String(message))}catch{}
      if(parsed?.id!=null&&parsed.method){
        const refusal=proxy.refuse(parsed);if(refusal){ws.send(JSON.stringify({id:parsed.id,error:{code:-32000,message:refusal}}));return}
        const result=proxy.answer(parsed);if(result!==undefined){ws.send(JSON.stringify({id:parsed.id,result}));return}
      }
      server.send(message);
    });
  });
  proxy.stop=()=>{proxy.stopped=true;for(const ws of proxy.sockets.splice(0))ws.close({code:1011,reason:"harness stopped"})};
  proxy.start=()=>{proxy.stopped=false};
  return proxy;
}

// One thread per name, opened on the first. branch makes the project a Git repository on that branch with a change to review;
// desktop stands in for the desktop app's bridge (its folder picker counts its calls), where window.prompt throws as it does there.
// nativeDialogs lists every browser dialog the page opened (each is dismissed): the app asks in its own.
async function openHeaderApp(page,{names=["Release checklist"],replies=[],branch=null,desktop=false}={}){
  const nativeDialogs=[];page.on("dialog",dialog=>{nativeDialogs.push(dialog.type()+": "+dialog.message());dialog.dismiss().catch(()=>{})});
  const harness=await startRelayHarness({replies});
  for(const name of names)harness.seedThread(name,[{user:"Prepare the "+name.toLowerCase(),items:[replyItem("seed-reply-"+harness.threads.length,"Ready when you are.")]}]);
  await routeRelayApp(page,harness);
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  if(branch)await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:true,cwd:harness.repo,root:harness.repo,branch,branches:[branch],upstream:null,status:[{path:"app.js",index:" ",workingTree:"M"}],remotes:[],worktrees:[{path:harness.repo,branch}]}));
  const proxy=await proxyRelay(page,harness);
  if(desktop)await page.addInitScript(()=>{
    window.prompt=()=>{throw new Error("prompt() is and will not be supported.")};
    window.trebellDesktop={pickDirectory:async()=>{window.__folderPicks=(window.__folderPicks||0)+1;return null}};
  });
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${names[0]}"]`)});
  await row.locator(".thread-main").click();
  await expect(row).toHaveClass(/active/);await expect(page.getByTestId("composer")).not.toHaveAttribute("placeholder","Opening thread…");
  return {harness,proxy,nativeDialogs,header:page.locator(".chat-workspace .workspace-header")};
}
// The header's theme button, as a person switches between dark and light, and the window at 1280x800 and 900x800 in that mode.
async function switchMode(page,mode){
  const html=page.locator("html");if(await html.getAttribute("data-mode")===mode)return;
  const toggle=page.getByTestId("appearance-toggle").first();
  if(await toggle.isVisible())await toggle.click();
  else{await page.getByRole("button",{name:"More actions",exact:true}).click();await page.getByRole("button",{name:/^Switch to (light|dark) mode$/}).click()}
  await expect(html).toHaveAttribute("data-mode",mode);
}
async function shoot(page,name){
  const mode=await page.locator("html").getAttribute("data-mode");
  for(const width of [1280,900]){await page.setViewportSize({width,height:800});await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-"+width+"x800.png"})}
  await page.setViewportSize({width:1280,height:800});
}
// How far a control stands out from the header, as a person sees it: the contrast of its text at its opacity with the background
// behind it, once a mode switch has finished fading the colours.
const contrast=locator=>locator.evaluate(async node=>{
  await Promise.all(document.getAnimations().filter(animation=>animation instanceof CSSTransition).map(animation=>animation.finished.catch(()=>null)));
  const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
  const luminance=channels=>channels.reduce((sum,value,index)=>{value/=255;return sum+[0.2126,0.7152,0.0722][index]*(value<=0.03928?value/12.92:((value+0.055)/1.055)**2.4)},0);
  let back=node.parentElement;while(back&&getComputedStyle(back).backgroundColor==="rgba(0, 0, 0, 0)")back=back.parentElement;
  const behind=rgb(getComputedStyle(back||document.body).backgroundColor),style=getComputedStyle(node),alpha=Number(style.opacity);
  const [lighter,darker]=[luminance(rgb(style.color).map((value,index)=>value*alpha+behind[index]*(1-alpha))),luminance(behind)].sort((a,b)=>b-a);
  return (lighter+0.05)/(darker+0.05);
});
const dialog=page=>page.locator("dialog.inspector-text-prompt");
// A person clicks the title, types the new name over the old one and presses Enter.
async function rename(page,title,name){
  await title.click();await expect(dialog(page)).toBeVisible();
  await page.keyboard.type(name,{delay:25});await page.keyboard.press("Enter");await expect(dialog(page)).toHaveCount(0);
}

test("a refused rename says why and keeps the title, and while the harness is stopped the title says why it cannot rename",async({page})=>{
  test.setTimeout(90_000);
  const errors=[];page.on("pageerror",error=>errors.push(String(error?.message||error)));
  const {harness,proxy,header}=await openHeaderApp(page);
  const title=header.locator(".thread-title-button"),thread=harness.threads[0];
  try{
    await expect(title).toHaveText("Release checklist");
    proxy.refuse=message=>message.method==="thread/name/set"?"Thread name store is read-only":null;
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      await rename(page,title,"Ship the release");
      await expect(page.getByTestId("app-action-error")).toHaveText("Could not rename thread: Thread name store is read-only");
      await expect(title).toHaveText("Release checklist");await expect(title).toBeFocused();
      await expect(page.locator('.thread-row.active .thread-main[title="Release checklist"]')).toBeVisible();
      await shoot(page,"header-rename-refused");
    }
    expect(harness.threadStore.get(thread.id).name).toBe("Release checklist");
    expect(errors).toEqual([]);
    // The harness stops: the title cannot rename and says why instead of opening a dialog that fails.
    proxy.stop();
    await expect(title).toBeDisabled();
    await expect(title).toHaveAttribute("title","Release checklist · Renaming needs Trebell Native to be connected");
    for(const mode of ["dark","light"]){
      await page.setViewportSize({width:1280,height:800});await switchMode(page,mode);
      await shoot(page,"header-rename-harness-stopped");
    }
    // Once it is back, the same rename goes through.
    proxy.refuse=()=>null;proxy.start();
    await expect(title).toBeEnabled({timeout:20_000});await expect(title).toHaveAttribute("title","Release checklist · Rename thread");
    await rename(page,title,"Ship the release");
    await expect(title).toHaveText("Ship the release");
    await expect(page.locator('.thread-row.active .thread-main[title="Ship the release"]')).toBeVisible();
    expect(harness.threadStore.get(thread.id).name).toBe("Ship the release");
    expect(errors).toEqual([]);
  }finally{await harness.close()}
});

test("Rename asks in the app's own dialog in the browser too, never the browser's prompt, and works from the keyboard",async({page})=>{
  test.setTimeout(60_000);
  const {harness,nativeDialogs,header}=await openHeaderApp(page);
  const title=header.locator(".thread-title-button"),question=dialog(page),field=question.getByRole("textbox",{name:"Rename thread"});
  try{
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      await title.click();
      await expect(question).toBeVisible();await expect(field).toBeFocused();await expect(field).toHaveValue("Release checklist");
      await shoot(page,"header-rename-question");
      // Escape leaves the title as it was, with focus back on it.
      await page.keyboard.type("Not this",{delay:20});await page.keyboard.press("Escape");
      await expect(question).toHaveCount(0);await expect(title).toHaveText("Release checklist");await expect(title).toBeFocused();
    }
    // From the keyboard alone: Enter on the title asks, the new name is typed over the old one, and Enter renames.
    await page.keyboard.press("Enter");await expect(field).toBeFocused();
    await page.keyboard.type("Ship the release",{delay:20});await page.keyboard.press("Enter");
    await expect(question).toHaveCount(0);await expect(title).toHaveText("Ship the release");await expect(title).toBeFocused();
    expect(harness.threadStore.get(harness.threads[0].id).name).toBe("Ship the release");
    expect(nativeDialogs).toEqual([]);
  }finally{await harness.close()}
});

test("Enter held on the title asks once and its repeats do not rename; Enter pressed in the question renames, and a double click's second click answers nothing",async({page})=>{
  test.setTimeout(60_000);
  const {harness,proxy,nativeDialogs,header}=await openHeaderApp(page);
  const title=header.locator(".thread-title-button"),question=dialog(page),field=question.getByRole("textbox",{name:"Rename thread"});
  const sent=[];proxy.answer=message=>{if(message.method==="thread/name/set")sent.push(message.params?.name);return undefined};
  try{
    let current="Release checklist";
    for(const [mode,name] of [["dark","Ship the release"],["light","Release day"]]){
      await switchMode(page,mode);
      // The press that asks goes on repeating in the question, where it would give OK with the name unread.
      await title.focus();await page.keyboard.down("Enter");await expect(field).toBeFocused();
      await page.keyboard.down("Enter");await page.keyboard.down("Enter");await page.keyboard.up("Enter");
      await expect(question).toHaveCount(1);await expect(field).toBeFocused();await expect(field).toHaveValue(current);
      expect(sent).toEqual(mode==="dark"?[]:["Ship the release"]);
      await shoot(page,"header-rename-held-enter");
      // A press of its own in the question renames.
      await page.keyboard.type(name,{delay:20});await page.keyboard.press("Enter");
      await expect(question).toHaveCount(0);await expect(title).toHaveText(name);await expect(title).toBeFocused();
      current=name;
    }
    expect(sent).toEqual(["Ship the release","Release day"]);
    // The second click of a double click that lands on OK or Cancel answers nothing; a click of its own does.
    await title.click();await expect(field).toBeFocused();
    for(const name of ["OK","Cancel"])await question.getByRole("button",{name,exact:true}).dispatchEvent("click",{detail:2});
    await expect(question).toHaveCount(1);await expect(field).toHaveValue("Release day");
    await question.getByRole("button",{name:"Cancel",exact:true}).click();await expect(question).toHaveCount(0);
    expect(sent).toEqual(["Ship the release","Release day"]);
    expect(harness.threadStore.get(harness.threads[0].id).name).toBe("Release day");
    expect(nativeDialogs).toEqual([]);
  }finally{await harness.close()}
});

test("app shortcuts wait while the rename question is open, so the new name lands on the thread it was asked for",async({page})=>{
  test.setTimeout(60_000);
  const {harness,nativeDialogs,header}=await openHeaderApp(page,{replies:[{text:"Renamed and ready."}]});
  const title=header.locator(".thread-title-button"),question=dialog(page),thread=harness.threads[0];
  try{
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      await title.click();await expect(question).toBeVisible();
      // Ctrl+B, Ctrl+N and Ctrl+K would fold the sidebar, open New task and open the palette behind the question.
      await page.keyboard.press("Control+b");await page.keyboard.press("Control+n");await page.keyboard.press("Control+k");
      await expect(question).toBeVisible();await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-collapsed/);
      await expect(page.locator(".thread-row.active .thread-main")).toHaveAttribute("title","Release checklist");
      await expect(page.getByTestId("command-palette")).toHaveCount(0);
      await shoot(page,"header-rename-shortcuts-wait");
      await page.keyboard.press("Escape");await expect(question).toHaveCount(0);await expect(title).toHaveText("Release checklist");
    }
    await title.click();await page.keyboard.press("Control+n");
    await page.keyboard.type("Ship the release",{delay:20});await page.keyboard.press("Enter");
    await expect(question).toHaveCount(0);await expect(title).toHaveText("Ship the release");
    await expect(page.locator('.thread-row.active .thread-main[title="Ship the release"]')).toBeVisible();
    expect(harness.threadStore.get(thread.id).name).toBe("Ship the release");
    // The next message goes to that thread.
    await page.getByTestId("composer").click();await page.keyboard.type("Check the release notes",{delay:15});await page.keyboard.press("Enter");
    await expect(page.getByText("Renamed and ready.")).toBeVisible();
    expect(harness.threadStore.get(thread.id).turns).toHaveLength(2);
    expect(nativeDialogs).toEqual([]);
  }finally{await harness.close()}
});

test("Escape in the question a palette command asks closes that question alone, and focus goes back to where the palette was opened",async({page})=>{
  test.setTimeout(60_000);
  const {harness,nativeDialogs}=await openHeaderApp(page);
  const palette=page.getByTestId("command-palette"),question=dialog(page),composer=page.getByTestId("composer");
  try{
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      await composer.click();await page.keyboard.press("Control+K");await expect(palette).toBeVisible();
      await page.keyboard.type("Link pull request",{delay:20});await page.keyboard.press("Enter");
      await expect(question.getByRole("textbox",{name:"Pull request URL"})).toBeFocused();
      await shoot(page,"palette-link-pr-question");
      // One Escape: the question goes, the command ends with nothing linked as Cancel would, and so does the palette.
      await page.keyboard.press("Escape");
      await expect(question).toHaveCount(0);await expect(palette).toHaveCount(0);
      await expect(composer).toBeFocused();
      await expect(page.getByTestId("app-action-error")).toHaveCount(0);
    }
    expect(nativeDialogs).toEqual([]);
  }finally{await harness.close()}
});

test("Tab and Shift+Tab move between the field and the buttons of the question a palette command asks",async({page})=>{
  test.setTimeout(60_000);
  const {harness,nativeDialogs}=await openHeaderApp(page);
  const palette=page.getByTestId("command-palette"),question=dialog(page),composer=page.getByTestId("composer");
  const field=question.getByRole("textbox",{name:"Pull request URL"}),cancel=question.getByRole("button",{name:"Cancel",exact:true}),ok=question.getByRole("button",{name:"OK",exact:true});
  try{
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      await composer.click();await page.keyboard.press("Control+K");await expect(palette).toBeVisible();
      await page.keyboard.type("Link pull request",{delay:20});await page.keyboard.press("Enter");
      await expect(field).toBeFocused();
      await page.keyboard.press("Tab");await expect(cancel).toBeFocused();
      await page.keyboard.press("Tab");await expect(ok).toBeFocused();
      await shoot(page,"palette-link-pr-question-tab");
      await page.keyboard.press("Shift+Tab");await expect(cancel).toBeFocused();
      await page.keyboard.press("Shift+Tab");await expect(field).toBeFocused();
      // Cancel, reached with Tab and pressed with Enter, ends the command as Escape does.
      await page.keyboard.press("Tab");await page.keyboard.press("Enter");
      await expect(question).toHaveCount(0);await expect(palette).toHaveCount(0);await expect(composer).toBeFocused();
    }
    expect(nativeDialogs).toEqual([]);
  }finally{await harness.close()}
});

test("an agent's question that comes while the rename question is open leaves Tab to the rename question, then keeps it in its own",async({page})=>{
  test.setTimeout(60_000);
  const {harness,proxy,nativeDialogs,header}=await openHeaderApp(page);
  const title=header.locator(".thread-title-button"),question=dialog(page),agent=page.locator(".question-modal");
  const field=question.getByRole("textbox",{name:"Rename thread"}),cancel=question.getByRole("button",{name:"Cancel",exact:true});
  try{
    for(const [index,mode] of ["dark","light"].entries()){
      await switchMode(page,mode);
      await title.click();await expect(field).toBeFocused();
      await page.keyboard.press("Tab");await expect(cancel,"Tab before the agent asks").toBeFocused();
      await page.keyboard.press("Shift+Tab");await expect(field).toBeFocused();
      // The running agent asks something meanwhile: its question waits behind the rename question, which keeps focus.
      proxy.sockets.at(-1).send(JSON.stringify({id:9100+index,method:"item/tool/requestUserInput",params:{threadId:harness.threads[0].id,questions:[{id:"pick",header:"Pick one",question:"Which branch should I use?",options:[],allowMultiple:false}]}}));
      await expect(agent).toHaveCount(1);await expect(field).toBeFocused();
      await page.keyboard.press("Tab");await expect(cancel,"Tab once the agent's question is there").toBeFocused();
      await page.keyboard.press("Shift+Tab");await expect(field).toBeFocused();
      await shoot(page,"header-rename-over-agent-question");
      // Escape closes the rename question alone; Tab then goes into the agent's question, which keeps it there.
      await page.keyboard.press("Escape");await expect(question).toHaveCount(0);await expect(agent).toHaveCount(1);
      await page.keyboard.press("Tab");
      expect(await page.evaluate(()=>Boolean(document.activeElement?.closest?.(".question-modal"))),"focus after Tab").toBe(true);
      await agent.getByRole("button",{name:"Cancel",exact:true}).click();await expect(agent).toHaveCount(0);
    }
    expect(nativeDialogs).toEqual([]);
  }finally{await harness.close()}
});

test("switching the theme with the header's button leaves an action's error on screen to be read",async({page})=>{
  test.setTimeout(60_000);
  const {harness,proxy,header}=await openHeaderApp(page);
  const title=header.locator(".thread-title-button"),alert=page.getByTestId("app-action-error"),reason="Could not rename thread: Thread name store is read-only";
  try{
    proxy.refuse=message=>message.method==="thread/name/set"?"Thread name store is read-only":null;
    // The error shows in one mode and is still there once the button has switched to the other.
    for(const [from,to] of [["dark","light"],["light","dark"]]){
      await switchMode(page,from);
      await rename(page,title,"Ship the release");await expect(alert).toHaveText(reason);
      await switchMode(page,to);await expect(alert).toHaveText(reason);
      await shoot(page,"header-error-kept-after-theme-switch");
    }
  }finally{await harness.close()}
});

for(const build of ["browser","desktop"])test(`the project crumb opens Projects in the ${build} build, and nothing beside it poses as a menu`,async({page})=>{
  test.setTimeout(60_000);
  const {harness,header}=await openHeaderApp(page,{desktop:build==="desktop"});
  const crumb=header.locator(".project-crumb:not(.sidebar-reopen)");
  try{
    await expect(crumb).toHaveText("Relay History Project");
    // One control: no chevron beside it or inside it that looks like a menu and is none.
    await expect(header.locator(".workspace-breadcrumb button").filter({has:page.locator("svg.lucide-chevron-down")}).filter({hasNot:page.locator("strong")})).toHaveCount(0);
    await expect(header.getByRole("button",{name:"Projects and General chat"})).toHaveCount(0);
    await expect(crumb).not.toHaveAttribute("aria-haspopup",/./);await expect(crumb).toHaveAttribute("title","Relay History Project · Projects and workspaces");
    for(const mode of ["dark","light"]){await switchMode(page,mode);await shoot(page,"header-project-crumb-"+build)}
    await switchMode(page,"dark");
    await crumb.click();
    const heading=page.getByRole("heading",{name:"Projects",level:1});
    await expect(heading).toBeVisible();await expect(heading).toBeFocused();
    if(build==="desktop")expect(await page.evaluate(()=>window.__folderPicks||0)).toBe(0);
    await page.screenshot({animations:"disabled",path:auditDir+"header-project-crumb-opens-projects-"+build+"-dark-1280x800.png"});
  }finally{await harness.close()}
});

test("Review waits while a turn runs, and a review the harness does not start adds no running step",async({page})=>{
  test.setTimeout(90_000);
  const held=gate();
  const {harness,proxy,header}=await openHeaderApp(page,{branch:"main",replies:[async()=>{await held.promise;return {text:"Long task done."}}]});
  const review=header.getByRole("button",{name:"Review",exact:true}),stop=header.getByRole("button",{name:"Stop",exact:true});
  try{
    await expect(review).toBeEnabled();await expect(review).toHaveAttribute("title","Review uncommitted changes");
    const enabled={};for(const mode of ["dark","light"]){await switchMode(page,mode);enabled[mode]=await contrast(review)}
    await switchMode(page,"dark");
    await page.getByTestId("composer").click();await page.keyboard.type("Run the long task",{delay:20});await page.keyboard.press("Enter");
    await expect(stop).toBeVisible({timeout:15_000});
    await expect(review).toBeDisabled();
    await expect(review).toHaveAttribute("title","Wait for the running turn to finish before reviewing");
    // Held, Review reads as held at a glance in both modes: it stands out from the header far less than when it can be clicked.
    for(const mode of ["dark","light"]){await switchMode(page,mode);expect(await contrast(review)).toBeLessThan(enabled[mode]*0.6);await shoot(page,"header-review-during-turn")}
    await switchMode(page,"dark");
    held.open();
    await expect(page.getByText("Long task done.")).toBeVisible({timeout:15_000});
    await expect(stop).toHaveCount(0);await expect(review).toBeEnabled();
    // A harness that answers without starting a review turn: nothing claims a review is running, and the header says it did not start.
    proxy.answer=message=>message.method==="review/start"?{}:undefined;
    await review.click();
    await expect(page.getByTestId("app-action-error")).toHaveText("Could not start review: Trebell Native did not start a review.");
    await expect(page.getByText("Reviewing uncommitted changes")).toHaveCount(0);
    await expect(stop).toHaveCount(0);await expect(review).toBeEnabled();
  }finally{held.open();await harness.close()}
});

test("the header gives the whole thread title and branch name on hover when it cuts them",async({page})=>{
  test.setTimeout(60_000);
  const name="Release checklist for the payments service and the refund flow, with every step the on-call engineer has to run before the Friday deploy window closes",branch="feature/lane-b-sidebar-and-header-exploration-with-a-long-branch-name";
  const {harness,header}=await openHeaderApp(page,{names:[name],branch});
  const title=header.locator(".thread-title-button"),branchButton=header.locator(".branch-control");
  try{
    await expect(branchButton).toBeVisible();
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      for(const width of [1280,900]){
        await page.setViewportSize({width,height:800});
        // The header cuts the title (and at 900px shows the branch as an icon); the tooltip gives each whole.
        await expect.poll(()=>title.locator("strong").evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(true);
        await expect(title).toHaveAttribute("title",name+" · Rename thread");
        await expect(branchButton).toHaveAttribute("title",branch+" · Source control");
        await title.hover();
        await page.screenshot({animations:"disabled",path:auditDir+"header-long-title-branch-"+mode+"-"+width+"x800.png"});
      }
      await page.setViewportSize({width:1280,height:800});
    }
  }finally{await harness.close()}
});

test("/review typed in the composer says why a review did not start, as the header's Review does",async({page})=>{
  test.setTimeout(90_000);
  const errors=[];page.on("pageerror",error=>errors.push(String(error?.message||error)));
  const held=gate();
  const {harness,proxy,header}=await openHeaderApp(page,{branch:"main",replies:[async()=>{await held.promise;return {text:"Long task done."}}]});
  const composer=page.getByTestId("composer"),alert=page.getByTestId("app-action-error"),stop=header.getByRole("button",{name:"Stop",exact:true});
  const slashReview=async()=>{await composer.click();await page.keyboard.type("/review",{delay:25});await page.keyboard.press("Enter")};
  try{
    // While a turn runs, as the header's Review is held. (The theme button clears the message, so each mode asks again.)
    await composer.click();await page.keyboard.type("Run the long task",{delay:20});await page.keyboard.press("Enter");
    await expect(stop).toBeVisible({timeout:15_000});
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      await slashReview();
      await expect(alert).toHaveText("Could not start review: Wait for the running turn to finish before reviewing.");
      await expect(composer).toHaveValue("");
      await shoot(page,"header-slash-review-during-turn");
    }
    await switchMode(page,"dark");
    held.open();
    await expect(page.getByText("Long task done.")).toBeVisible({timeout:15_000});await expect(stop).toHaveCount(0);
    // A harness that answers without starting a review turn.
    proxy.answer=message=>message.method==="review/start"?{}:undefined;
    await slashReview();
    await expect(alert).toHaveText("Could not start review: Trebell Native did not start a review.");
    await expect(page.getByText("Reviewing uncommitted changes")).toHaveCount(0);
    // On New task there is no thread to review yet.
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"New task",exact:true}).click();
    await expect(page.locator(".thread-row.active")).toHaveCount(0);
    await slashReview();
    await expect(alert).toHaveText("Could not start review: Start or open a thread before reviewing.");
    expect(errors).toEqual([]);
  }finally{held.open();await harness.close()}
});

test("a rename whose dialog outlives the harness says Trebell Native is not connected, as the title does",async({page})=>{
  test.setTimeout(60_000);
  const {harness,proxy,header}=await openHeaderApp(page);
  const title=header.locator(".thread-title-button");
  try{
    // The theme button clears the message, so each mode renames again with the harness back.
    for(const mode of ["dark","light"]){
      await switchMode(page,mode);
      proxy.start();await expect(title).toBeEnabled({timeout:20_000});
      await title.click();await expect(dialog(page)).toBeVisible();
      proxy.stop();
      await expect(title).toHaveAttribute("title","Release checklist · Renaming needs Trebell Native to be connected");
      await page.keyboard.type("Ship the release",{delay:25});await page.keyboard.press("Enter");await expect(dialog(page)).toHaveCount(0);
      const alert=page.getByTestId("app-action-error");
      await expect(alert).toHaveText("Could not rename thread: Trebell Native is not connected.");
      await expect(title).toHaveText("Release checklist");
      await shoot(page,"header-rename-harness-gone-mid-dialog");
    }
    expect(harness.threadStore.get(harness.threads[0].id).name).toBe("Release checklist");
  }finally{await harness.close()}
});
