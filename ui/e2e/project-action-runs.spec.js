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
    const drawer=page.getByTestId("drawer"),tab=drawer.locator(".terminal-tab-list button.active");
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
