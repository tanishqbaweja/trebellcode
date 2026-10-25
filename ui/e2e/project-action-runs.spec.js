import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The header's action button while its action runs, used as a person uses it. The server's side is scripted: a run answers with the
// terminal it started, the terminal list holds that terminal, and its terminal sockets say whether it runs (the watch socket the
// button holds) and what it printed (the pane's), so the action ends when the test says.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

test("the header's action button shows its action running, shows its terminal on a second click instead of starting it again, and Stop ends it",async({page,request})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  const script={id:"dev-server",name:"Dev server",command:"node server.js",previewUrl:null,autoOpenPreview:false,runOnWorktreeCreate:false,waitForSetup:false};
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Action Workspace",activate:true,scripts:[script],preferredScriptId:script.id}});
  let runs=0,stops=0,current=null;const watchers=new Set(),panes=new Set();
  const session=id=>({id,name:"Dev server",cwd:boot.cwd,environmentId:null,environmentName:"Local machine",environmentType:"local",cols:120,rows:32,running:current?.id===id&&current.running,exitCode:current?.id===id&&!current.running?1:null,createdAt:Date.now(),updatedAt:Date.now(),buffer:""});
  const end=()=>{current={...current,running:false};for(const ws of [...watchers,...panes])ws.send(JSON.stringify({type:"exit",exitCode:1,signal:null}))};
  await page.route(/\/api\/project-script\/run$/,route=>{runs++;current={id:"action-run-"+runs,running:true};return json(route,{ok:true,script,session:session(current.id),previewUrl:null})});
  await page.route(/\/api\/project-script\/stop$/,route=>{stops++;end();return json(route,{ok:true,session:session(current.id)})});
  await page.route(/\/api\/terminal\/sessions(?:\?.*)?$/,route=>route.request().method()==="GET"?json(route,{sessions:current?[session(current.id)]:[]}):route.fallback());
  // The project's running actions, asked as it opens, answer only after the first run: a late answer keeps the run made meanwhile.
  const heldRuns=[];let runsAnswered=false;
  await page.route(/\/api\/project-script\/runs(?:\?.*)?$/,route=>runsAnswered?json(route,{runs:{}}):heldRuns.push(route));
  await page.routeWebSocket(/\/api\/terminal\/ws\?/,ws=>{
    const url=new URL(ws.url());
    if(url.searchParams.get("watch")==="1"){watchers.add(ws);ws.onClose(()=>watchers.delete(ws));ws.send(JSON.stringify({type:"state",running:Boolean(current?.running),exitCode:null}));return}
    panes.add(ws);ws.onClose(()=>panes.delete(ws));
    ws.send(JSON.stringify({type:"snapshot",session:{...session(url.searchParams.get("session")),buffer:"DEV SERVER READY on 127.0.0.1:4173\r\n"}}));
  });
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    const header=page.locator(".workspace-header"),button=header.getByRole("button",{name:"Dev server",exact:true}),stop=header.getByRole("button",{name:"Stop Dev server",exact:true});
    const drawer=page.getByTestId("drawer"),tab=drawer.locator(".terminal-tab-list .terminal-tab.active");
    await expect(button).toBeVisible();await expect(stop).toHaveCount(0);
    await button.click();
    await expect(button,"the button shows its action running").toHaveAttribute("data-running","true");
    await expect(button).toHaveAttribute("title","Dev server is running · Show its terminal");
    await expect(stop).toBeVisible();
    await expect(tab).toContainText("Dev server");await expect(drawer).toContainText("DEV SERVER READY");
    await expect.poll(()=>heldRuns.length,{message:"the project's running actions were asked for"}).toBeGreaterThan(0);
    runsAnswered=true;for(const route of heldRuns.splice(0))await json(route,{runs:{}});
    await expect(button,"a late answer keeps the run").toHaveAttribute("data-running","true");
    await page.screenshot({animations:"disabled",path:auditDir+"project-action-header-running-dark-1280.png"});
    // A second click shows the running terminal (the drawer closed meanwhile) and starts nothing.
    await header.getByRole("button",{name:"Toggle terminal",exact:true}).click();await expect(drawer).toHaveCount(0);
    await button.click();
    await expect(tab).toContainText("Dev server");
    expect(runs,"one run").toBe(1);
    await stop.click();
    await expect(button,"Stop ends it").not.toHaveAttribute("data-running");await expect(stop).toHaveCount(0);
    expect(stops).toBe(1);
    await expect(tab.locator("em"),"its terminal stays, with its exit").toHaveText("1");
    await page.screenshot({animations:"disabled",path:auditDir+"project-action-header-stopped-dark-1280.png"});
    // The next click starts it afresh; it then ends on its own, and the button says so.
    await button.click();
    await expect(button).toHaveAttribute("data-running","true");expect(runs).toBe(2);
    await expect.poll(()=>watchers.size,{message:"the button watches the new run"}).toBe(1);
    end();
    await expect(button,"an action that ended on its own").not.toHaveAttribute("data-running");await expect(stop).toHaveCount(0);
  }finally{await request.post("/api/projects",{data:{path:boot.cwd,scripts:[],preferredScriptId:null}})}
});

// The server side of action runs for the tests below, scripted as above: each run answers after latencyMs (a real run answered in
// 450-1275 ms on a loaded host) with a terminal of its own, the terminal list holds every terminal started (the drawer's New and
// splits too, in the order they started), a watch socket says whether its terminal runs, and the project's running action is told as
// the project opens. With held, a run answers only once answer() is called, and the list holds its terminal from its answer on, as
// the server lists a run once it has started it. Proof screenshots go to TREBELL_PROOF_SHOTS when it is set.
const proofShots=process.env.TREBELL_PROOF_SHOTS?String(process.env.TREBELL_PROOF_SHOTS).replace(/[\\/]*$/,"/"):auditDir+"proof-";
if(process.env.TREBELL_PROOF_SHOTS)mkdirSync(proofShots,{recursive:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const devServer={id:"dev-server",name:"Dev server",command:"node server.js",previewUrl:null,autoOpenPreview:false,runOnWorktreeCreate:false,waitForSetup:false};
async function scriptedActions(page,request,{latencyMs=500,held=false}={}){
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Action Workspace",activate:true,scripts:[devServer],preferredScriptId:devServer.id}});
  const started=[],shells=[],sockets=new Map();
  let answer=()=>{};const answering=held?new Promise(resolve=>answer=resolve):null;
  const session=run=>({id:run.id,name:run.name||devServer.name,cwd:boot.cwd,environmentId:null,environmentName:"Local machine",environmentType:"local",cols:120,rows:32,running:run.running,exitCode:run.running?null:1,createdAt:run.createdAt,updatedAt:Date.now(),buffer:""});
  await page.route(/\/api\/project-script\/run$/,async route=>{
    const run={id:"action-run-"+(started.length+1),running:true,createdAt:Date.now()};
    if(answering){await answering;started.push(run)}else{started.push(run);await delay(latencyMs)}
    return json(route,{ok:true,script:devServer,session:session(run),previewUrl:null});
  });
  await page.route(/\/api\/project-script\/stop$/,route=>{
    const run=[...started].reverse().find(item=>item.running);
    if(run){run.running=false;for(const ws of sockets.get(run.id)||[])ws.send(JSON.stringify({type:"exit",exitCode:1,signal:null}))}
    return json(route,{ok:true,session:run?session(run):null});
  });
  await page.route(/\/api\/terminal\/sessions(?:\?.*)?$/,route=>{
    const method=route.request().method();
    if(method==="GET")return json(route,{sessions:[...started,...shells].sort((a,b)=>a.createdAt-b.createdAt).map(session)});
    if(method!=="POST")return route.fallback();
    const shell={id:"terminal-"+(shells.length+1),name:route.request().postDataJSON()?.name||"Terminal",running:true,createdAt:Date.now()};shells.push(shell);
    return json(route,{session:session(shell)});
  });
  await page.route(/\/api\/project-script\/runs(?:\?.*)?$/,route=>json(route,{runs:Object.fromEntries(started.filter(run=>run.running).map(run=>[devServer.id,run.id]))}));
  await page.routeWebSocket(/\/api\/terminal\/ws\?/,ws=>{
    const url=new URL(ws.url()),id=url.searchParams.get("session"),run=[...started,...shells].find(item=>item.id===id);
    if(!sockets.has(id))sockets.set(id,new Set());sockets.get(id).add(ws);ws.onClose(()=>sockets.get(id)?.delete(ws));
    if(url.searchParams.get("watch")==="1"){ws.send(JSON.stringify({type:"state",running:Boolean(run?.running),exitCode:null}));return}
    ws.send(JSON.stringify({type:"snapshot",session:{...(run?session(run):{id}),buffer:shells.includes(run)?"C:\\Action Workspace>":"DEV SERVER READY on 127.0.0.1:4173\r\n"}}));
  });
  return {started,answer:()=>answer(),cleanup:()=>request.post("/api/projects",{data:{path:boot.cwd,scripts:[],preferredScriptId:null}})};
}
const headerAction=page=>{const header=page.locator(".workspace-header");return {button:header.getByRole("button",{name:"Dev server",exact:true}),stop:header.getByRole("button",{name:"Stop Dev server",exact:true})}};

test("a double click on the header's action button starts the action once",async({page,request})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const {started,cleanup}=await scriptedActions(page,request);
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    const {button,stop}=headerAction(page),tabs=page.getByTestId("drawer").locator(".terminal-tab-list .terminal-tab-select");
    // The second click comes 150 ms after the first, while the first run is still on its way.
    await button.click();await page.waitForTimeout(150);await button.click();
    await expect(button).toHaveAttribute("data-running","true");await expect(stop).toBeVisible();
    await expect(tabs.filter({hasText:"Dev server"})).toHaveCount(1,{timeout:15_000});
    // The second click asks for the action's terminal as the first did, so its command line takes the keyboard as after one click.
    await expect(page.getByTestId("drawer").locator(".terminal-pane.active .terminal-command-line input"),"the action's terminal takes the keyboard").toBeFocused();
    await page.waitForTimeout(800);
    await page.screenshot({animations:"disabled",path:proofShots+"F1-double-click-one-run.png"});
    console.log("runs sent:",started.length,"terminal tabs:",JSON.stringify(await tabs.allInnerTexts()));
    expect(started.length,"one run of the action").toBe(1);
    await expect(tabs.filter({hasText:"Dev server"}),"one terminal for it").toHaveCount(1);
  }finally{await cleanup()}
});

test("an action run from its Projects card shows running on the header's button, with its Stop",async({page,request})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const {started,cleanup}=await scriptedActions(page,request,{latencyMs:50});
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.getByRole("navigation",{name:"Destinations"}).getByRole("button",{name:"Projects",exact:true}).click();
    await page.locator(".project-card.active .project-action-run").filter({hasText:"Dev server"}).click();
    await expect(page.getByTestId("drawer")).toContainText("DEV SERVER READY");
    expect(started.length).toBe(1);
    const {button,stop}=headerAction(page);
    await expect(button,"the header's button shows the action running").toHaveAttribute("data-running","true",{timeout:5000}).catch(async error=>{
      console.log("header button data-running:",await button.getAttribute("data-running"),"title:",await button.getAttribute("title"),"Stop buttons:",await stop.count());throw error;
    });
    await expect(button).toHaveAttribute("title","Dev server is running · Show its terminal");
    await expect(stop,"with its Stop").toBeVisible();
    await page.screenshot({animations:"disabled",path:proofShots+"F2-projects-card-run-header-running.png"});
    await stop.click();
    await expect(button,"its Stop ends it").not.toHaveAttribute("data-running");await expect(stop).toHaveCount(0);
    expect(started.length,"the header never started a second run").toBe(1);
  }finally{await cleanup()}
});

test("Stop pressed from the keyboard leaves the keyboard on the action's button",async({page,request})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const {cleanup}=await scriptedActions(page,request,{latencyMs:50});
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    const {button,stop}=headerAction(page);
    await button.focus();await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("data-running","true");
    await button.focus();await page.keyboard.press("Tab");
    await expect(stop,"Tab from the action's button reaches its Stop").toBeFocused();
    await page.keyboard.press("Enter");
    await expect(stop).toHaveCount(0);
    await page.waitForTimeout(300);
    console.log("focus after Stop:",await page.evaluate(()=>document.activeElement===document.body?"body":document.activeElement?.getAttribute("aria-label")||document.activeElement?.tagName));
    await page.screenshot({animations:"disabled",path:proofShots+"F5-keyboard-stop-focus-on-action.png"});
    await expect(button,"the keyboard goes on from the action's button").toBeFocused();
    // And Enter there runs the action again, from the keyboard.
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("data-running","true");
  }finally{await cleanup()}
});

// The terminal asked for while the header's action is on its way, with no terminal listed yet: the drawer opened with Toggle terminal,
// Focus terminal (Ctrl+`), or a press in the drawer already open. The action's terminal takes the keyboard as it shows, as after the
// press that ran the action alone. Its answer asks as of that press, and it used to take back the ask made since, so the keyboard
// stayed on Toggle terminal, fell to the page from Create terminal as the action's terminal replaced it, or stayed where the press in
// the drawer left it.
for(const [way,slug] of [["Toggle terminal","toggle"],["Ctrl+`","focus-terminal"],["a press in the drawer","drawer-press"]])test(`the action's terminal takes the keyboard as it shows after ${way} while the header's action starts`,async({page,request})=>{
  test.setTimeout(60_000);
  await page.setViewportSize({width:1280,height:800});
  const {started,answer,cleanup}=await scriptedActions(page,request,{held:true});
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    const {button}=headerAction(page),toggle=page.getByTestId("terminal-toggle"),drawer=page.getByTestId("drawer"),none=drawer.getByText("No terminal session",{exact:true});
    const commandLine=drawer.locator(".terminal-pane.active .terminal-command-line input");
    if(way==="a press in the drawer"){await toggle.click();await expect(none).toBeVisible()}
    await button.click();
    if(way==="Toggle terminal")await toggle.click();
    else if(way==="Ctrl+`")await page.keyboard.press("Control+Backquote");
    else await none.click();
    await expect(none,"no terminal is listed while the run is on its way").toBeVisible();
    expect(started.length).toBe(0);
    answer();
    await expect(button).toHaveAttribute("data-running","true");
    await expect(drawer.locator(".terminal-tab")).toHaveCount(1);await expect(commandLine).toBeEnabled();
    await expect(commandLine,"the action's terminal takes the keyboard ("+way+")").toBeFocused();
    await page.screenshot({animations:"disabled",path:proofShots+"I1-ask-while-starting-"+slug+"-dark-1280.png"});
    expect(started.length,"one run of the action").toBe(1);
  }finally{await cleanup()}
});

// What the drawer shows after the header's action is pressed: the action's tab current and running (no exit mark), and its terminal
// in the pane marked shown, with a live command line that takes the keyboard. pane(name) is the pane whose head names that terminal.
function actionTerminal(page){
  const drawer=page.getByTestId("drawer"),current=drawer.locator(".terminal-tab.active"),panes=drawer.locator(".terminal-pane");
  const pane=name=>panes.filter({has:page.locator(".terminal-pane-head",{hasText:name})});
  const showsRun=async(when,count=1)=>{
    await expect(current.locator("bdi"),when+": the action's tab is current").toHaveText("Dev server");
    await expect(current.locator("em"),when+": the tab marked current is the running one").toHaveCount(0);
    await expect(panes,when+": the panes shown").toHaveCount(count);
    await expect(pane("Dev server"),when+": the action's terminal is shown").toHaveCount(1);
    const input=pane("Dev server").locator(".terminal-command-line input");
    await expect(input,when+": the terminal shown is the run's, with a live command line, not a stopped run's").toBeEnabled();
    await expect(input).toHaveAttribute("placeholder","Type a command…");
    await expect(pane("Dev server"),when+": it is the pane marked shown").toHaveClass(/\bactive\b/);
    await expect(input,when+": its command line takes the keyboard").toBeFocused();
  };
  return {drawer,current,panes,pane,showsRun};
}

// The header's action run with the drawer open on another terminal: the action's last run, stopped (its terminal stays listed, with
// its exit), a terminal started with the drawer's New, or a split of two others. The run's own terminal shows under its tab, marked
// current. The drawer marked the run's tab current but went on showing the terminal shown before: the stopped run's, its command
// line off ("Stopped terminal history"), or New's, so the button seemed to do nothing.
for(const [way,mode] of [["mouse","dark"],["keyboard","light"]])test(`a run of the header's action shows its own terminal in the drawer open on another one, a stopped run's, New's or a split's (${way}, ${mode})`,async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const {started,cleanup}=await scriptedActions(page,request,{latencyMs:50});
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    if(mode==="light"){await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
    const {button,stop}=headerAction(page),{drawer,current,panes,pane,showsRun}=actionTerminal(page);
    // Pressed as a person does: a click (a double click on the running action), or Enter on the button reached with the keyboard.
    const press=async({double=false}={})=>{if(way==="keyboard"){await button.focus();await page.keyboard.press("Enter")}else if(double)await button.dblclick();else await button.click()};
    const pressStop=async()=>{if(way==="keyboard"){await stop.focus();await page.keyboard.press("Enter")}else await stop.click();await expect(button).not.toHaveAttribute("data-running")};
    await press();
    await expect(button).toHaveAttribute("data-running","true");
    await showsRun("the first run, which opens the drawer");
    // Stopped, the run's terminal stays shown, with its exit, and the action is run again from there.
    await pressStop();
    await expect(current.locator("em"),"the stopped run's tab keeps its exit").toHaveText("1");
    await expect(panes.locator(".terminal-command-line input")).toHaveAttribute("placeholder","Stopped terminal history");
    await press();
    await expect(button).toHaveAttribute("data-running","true");
    await showsRun("run again with the drawer on the stopped run");
    await expect(drawer.locator(".terminal-tab"),"the stopped run's tab stays beside it").toHaveCount(2);
    await page.screenshot({animations:"disabled",path:proofShots+`CR9-1-rerun-drawer-${way}-${mode}-1280.png`});
    // A terminal started with New is shown; the action's button pressed while it runs shows the action's terminal and starts nothing.
    await drawer.locator(".terminal-new").click();
    await expect(pane("Terminal 1")).toHaveClass(/\bactive\b/);await expect(pane("Terminal 1").locator(".terminal-screen")).toContainText("Action Workspace>");
    await press({double:true});
    await showsRun("pressed while it runs, with New's terminal shown");
    expect(started.length,"no run started").toBe(2);
    await page.screenshot({animations:"disabled",path:proofShots+`CR9-1-running-over-new-${way}-${mode}-1280.png`});
    // A split of two other terminals: the action's terminal takes the place of the pane shown, and the other pane stays.
    await drawer.getByTitle("Split horizontally").click();
    await expect(panes).toHaveCount(2);await expect(pane("Terminal 2")).toHaveClass(/\bactive\b/);
    await pane("Dev server").locator(".terminal-screen").click();
    await drawer.locator(".terminal-tab-select").filter({hasText:"Terminal 1"}).click();
    await expect(pane("Terminal 1")).toHaveClass(/\bactive\b/);await expect(pane("Dev server")).toHaveCount(0);
    await press();
    await showsRun("pressed while it runs, with a split of two other terminals shown",2);
    await expect(pane("Terminal 2"),"the other pane stays").toHaveCount(1);
    // Stopped and run again there: the new run takes the stopped run's pane.
    await pressStop();
    await press();
    await expect(button).toHaveAttribute("data-running","true");
    await showsRun("run again with a split on the stopped run",2);
    await expect(pane("Terminal 2")).toHaveCount(1);
    await page.screenshot({animations:"disabled",path:proofShots+`CR9-1-rerun-split-${way}-${mode}-1280.png`});
    expect(started.length,"a run for each press while it was stopped").toBe(3);
  }finally{await cleanup()}
});

// The header's action, running, pressed with the drawer closed while a terminal started after it (New's) runs too: the drawer opens
// on the action's terminal, also on its first opening after the page is loaded again, in a window as narrow as 956 px. It opened on
// the newest running terminal, or marked the action's tab current over that terminal's pane.
test("the running header's action pressed with the drawer closed opens it on the action's terminal, not on a newer one, also after the page is loaded again",async({page,request})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:956,height:800});
  const {started,cleanup}=await scriptedActions(page,request,{latencyMs:50});
  try{
    await page.goto("/");
    await expect(page.getByTestId("composer")).toBeVisible();
    const {button}=headerAction(page),{drawer,pane,showsRun}=actionTerminal(page),toggle=page.getByTestId("terminal-toggle");
    await button.click();
    await expect(button).toHaveAttribute("data-running","true");
    await expect(pane("Dev server").locator(".terminal-command-line input")).toBeEnabled();
    await drawer.locator(".terminal-new").click();
    await expect(pane("Terminal 1")).toHaveClass(/\bactive\b/);
    await toggle.click();await expect(drawer).toHaveCount(0);
    await button.click();
    await showsRun("pressed with the drawer closed");
    await toggle.click();await expect(drawer).toHaveCount(0);
    // Loaded again, the page tells the action running, and the drawer's first opening (its code loads then) shows its terminal.
    await page.reload();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(button).toHaveAttribute("data-running","true");await expect(drawer).toHaveCount(0);
    await button.focus();await page.keyboard.press("Enter");
    await showsRun("pressed after the page is loaded again");
    expect(started.length,"one run").toBe(1);
    for(const mode of ["dark","light"]){
      if(await page.locator("html").getAttribute("data-mode")!==mode){await page.getByTestId("appearance-toggle").click();await expect(page.locator("html")).toHaveAttribute("data-mode",mode)}
      await page.screenshot({animations:"disabled",path:proofShots+`CR9-1-reload-running-${mode}-956.png`});
    }
  }finally{await cleanup()}
});
