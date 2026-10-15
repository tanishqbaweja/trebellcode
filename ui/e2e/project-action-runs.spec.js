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
// 450-1275 ms on a loaded host) with a terminal of its own, the terminal list holds every terminal started, and a watch socket says
// whether its terminal runs. Proof screenshots go to TREBELL_PROOF_SHOTS when it is set.
const proofShots=process.env.TREBELL_PROOF_SHOTS?String(process.env.TREBELL_PROOF_SHOTS).replace(/[\\/]*$/,"/"):auditDir+"proof-";
if(process.env.TREBELL_PROOF_SHOTS)mkdirSync(proofShots,{recursive:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const devServer={id:"dev-server",name:"Dev server",command:"node server.js",previewUrl:null,autoOpenPreview:false,runOnWorktreeCreate:false,waitForSetup:false};
async function scriptedActions(page,request,{latencyMs=500}={}){
  await request.post("/api/settings",{data:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",modelProvider:"openai"}});
  const boot=await (await request.get("/api/bootstrap")).json();
  await request.post("/api/projects",{data:{path:boot.cwd,name:"Action Workspace",activate:true,scripts:[devServer],preferredScriptId:devServer.id}});
  const started=[],sockets=new Map();
  const session=run=>({id:run.id,name:devServer.name,cwd:boot.cwd,environmentId:null,environmentName:"Local machine",environmentType:"local",cols:120,rows:32,running:run.running,exitCode:run.running?null:1,createdAt:Date.now(),updatedAt:Date.now(),buffer:""});
  await page.route(/\/api\/project-script\/run$/,async route=>{
    const run={id:"action-run-"+(started.length+1),running:true};started.push(run);
    await delay(latencyMs);
    return json(route,{ok:true,script:devServer,session:session(run),previewUrl:null});
  });
  await page.route(/\/api\/project-script\/stop$/,route=>{
    const run=[...started].reverse().find(item=>item.running);
    if(run){run.running=false;for(const ws of sockets.get(run.id)||[])ws.send(JSON.stringify({type:"exit",exitCode:1,signal:null}))}
    return json(route,{ok:true,session:run?session(run):null});
  });
  await page.route(/\/api\/terminal\/sessions(?:\?.*)?$/,route=>route.request().method()==="GET"?json(route,{sessions:started.map(session)}):route.fallback());
  await page.route(/\/api\/project-script\/runs(?:\?.*)?$/,route=>json(route,{runs:{}}));
  await page.routeWebSocket(/\/api\/terminal\/ws\?/,ws=>{
    const url=new URL(ws.url()),id=url.searchParams.get("session"),run=started.find(item=>item.id===id);
    if(!sockets.has(id))sockets.set(id,new Set());sockets.get(id).add(ws);ws.onClose(()=>sockets.get(id)?.delete(ws));
    if(url.searchParams.get("watch")==="1"){ws.send(JSON.stringify({type:"state",running:Boolean(run?.running),exitCode:null}));return}
    ws.send(JSON.stringify({type:"snapshot",session:{...(run?session(run):{id}),buffer:"DEV SERVER READY on 127.0.0.1:4173\r\n"}}));
  });
  return {started,cleanup:()=>request.post("/api/projects",{data:{path:boot.cwd,scripts:[],preferredScriptId:null}})};
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
