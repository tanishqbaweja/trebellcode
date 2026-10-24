import { test,expect } from "@playwright/test";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";
import { keepThreadMeta } from "./test-home.js";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

// holdRepair() keeps the repair requests from then on until the function it gives back answers them: started, or refused with the
// reason it is given (a harness slow to start the repair).
async function startHarness(thread,continuity){
  let socket=null,repairRequests=0,heldRepairs=null;
  const upstreamHttp=createServer(),wss=new WebSocketServer({noServer:true});
  upstreamHttp.on("upgrade",(req,raw,head)=>wss.handleUpgrade(req,raw,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    socket=ws;ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
      let result={};
      if(message.method==="initialize")result={userAgent:"verification-repair-fixture"};
      else if(message.method==="thread/list")result={data:[thread],nextCursor:null};
      else if(message.method==="thread/resume")result={thread,itemsBackwardsCursor:null,turnsBackwardsCursor:null};
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/continuity/get")result={continuity};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="skills/list"||message.method==="collaborationMode/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      else if(message.method==="thread/verification/repair"){
        repairRequests++;result={record:{id:"verification-1"},nextAction:{action:"repair"},turn:{id:"repair-turn",status:"inProgress"}};
        if(heldRepairs){const started=result;heldRepairs.push(reason=>ws.send(JSON.stringify(reason?{id:message.id,error:{code:-32000,message:reason}}:{id:message.id,result:started})));return}
      }
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",
    repairRequests:()=>repairRequests,
    holdRepair(){const held=heldRepairs=[];return reason=>{if(heldRepairs===held)heldRepairs=null;for(const answer of held.splice(0))answer(reason)}},
    async close(){relay.close();try{socket?.terminate()}catch{}wss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])},
  };
}

async function routeApp(page,harness,thread){
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current"};
  await keepThreadMeta(page);
  await page.route(/\/api\/bootstrap$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"verification-repair-ui",activeEnvironmentId:null,activeEnvironment:null})}));
  await page.route(/\/api\/state$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({settings,projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}})}));
  await page.route(/\/api\/models$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}})}));
  await page.route(/\/api\/projects$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({projects:[]})}));
  await page.route(/\/api\/environment\/themes$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]})}));
  await page.route(/\/api\/recovery$/,route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({enabled:false,items:[]})}));
}

test("failed verification can start a same-thread repair turn from continuity",async({page})=>{
  test.setTimeout(30_000);
  const thread={id:"verification-repair-ui-thread",name:"Verification repair fixture",preview:"Repair loop",cwd:process.cwd(),model:"test/coding-fast",createdAt:Date.now()/1000-20,updatedAt:Date.now()/1000,turns:[]};
  const continuity={
    threadId:thread.id,notes:{completedWork:[],unresolvedFailures:[],importantDecisions:[],artifactsCreated:[],pendingNextActions:[],updatedAt:0},
    workspace:{cwd:process.cwd(),branch:null,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default"},
    verification:{status:"failed",risk:"medium",verified:false,summary:"Affected parser tests failed.",updatedAt:Date.now()},
    completedTurnIds:["turn-1"],unresolvedFailures:[],recentFailures:[],artifactsCreated:[],pendingNextActions:[],completedWork:[],importantDecisions:[],meaningful:true,updatedAt:Date.now(),
  };
  const harness=await startHarness(thread,continuity);
  try{
    await routeApp(page,harness,thread);
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Verification repair fixture"]')});
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    await page.locator(".workspace-header").getByRole("button",{name:"Thread goal",exact:true}).click();
    const panel=page.getByTestId("goal-panel");await expect(panel).toBeVisible();
    await panel.locator(".goal-continuity-details>summary").click();
    const repair=panel.getByTestId("verification-repair-card");await expect(repair).toContainText("Verification needs repair");
    await expect(repair).toContainText("No second reviewer model is spawned");
    await repair.getByRole("button",{name:"Repair failed verification",exact:true}).click();
    await expect.poll(()=>harness.repairRequests()).toBe(1);
    await expect(panel.getByText("Repair turn started on this thread.")).toBeVisible();
    // The started repair holds the button, so the same failure cannot be repaired twice at once.
    const started=repair.getByRole("button",{name:"Repair started",exact:true});await expect(started).toBeDisabled();
    await expect.poll(()=>harness.repairRequests()).toBe(1);
    // The narrow Workspace cell names the folder; the full path is in its tooltip.
    const workspaceCell=panel.getByTestId("continuity-derived").locator("div").filter({hasText:"Workspace"}).locator("strong");
    await expect(workspaceCell).toHaveText(process.cwd().split(/[\\/]+/).filter(Boolean).pop());await expect(workspaceCell).toHaveAttribute("title",process.cwd());
    await page.setViewportSize({width:1280,height:800});
    await repair.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+"verification-repair-dark-1280x800.png",fullPage:true});
    await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    await expect.poll(()=>repair.evaluate(node=>getComputedStyle(node).backgroundColor)).toBe("rgb(255, 248, 240)");
    await page.screenshot({animations:"disabled",path:auditDir+"verification-repair-light-1280x800.png",fullPage:true});
  }finally{await harness.close()}
});

// A Goal panel drawn again (the right panel closed and opened again, or back from Files in a narrow window) while its repair is
// starting draws Continuity state open, with the repair's Starting… in sight above the goal's bar pinned at the panel's foot, and
// says what became of the start there: why the harness refused it, in view, with Repair failed verification offered again, or that
// the repair turn started, with Repair started held. The section was drawn closed, so the goal's buttons were off with nothing in
// sight saying why, a refusal was drawn where nothing showed it, and a start that went through was said nowhere, with Repair failed
// verification offered again for the same failure; then drawn open, but with Starting… below the window and the bar.
test("a Goal panel drawn again while its verification repair starts draws Continuity state open with Starting…, and says the start or why it was refused",async({page})=>{
  test.setTimeout(45_000);
  const thread={id:"verification-repair-redrawn-thread",name:"Verification repair redrawn",preview:"Repair loop",cwd:process.cwd(),model:"test/coding-fast",createdAt:Date.now()/1000-20,updatedAt:Date.now()/1000,turns:[]};
  const continuity={
    threadId:thread.id,notes:{completedWork:[],unresolvedFailures:[],importantDecisions:[],artifactsCreated:[],pendingNextActions:[],updatedAt:0},
    workspace:{cwd:process.cwd(),branch:null,environmentId:null,runtime:"codex",runtimeInstanceId:"codex-default"},
    verification:{status:"failed",risk:"medium",verified:false,summary:"Affected parser tests failed.",updatedAt:Date.now()},
    completedTurnIds:["turn-1"],unresolvedFailures:[],recentFailures:[],artifactsCreated:[],pendingNextActions:[],completedWork:[],importantDecisions:[],meaningful:true,updatedAt:Date.now(),
  };
  const harness=await startHarness(thread,continuity);
  try{
    await routeApp(page,harness,thread);
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Verification repair redrawn"]')});
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    const goalButton=page.locator(".workspace-header").getByRole("button",{name:"Thread goal",exact:true});
    await goalButton.click();
    const panel=page.getByTestId("goal-panel"),repair=panel.getByTestId("verification-repair-card");await expect(panel).toBeVisible();
    const summary=panel.locator(".goal-continuity-details>summary"),save=panel.locator(":scope>.goal-actions>button.primary");
    const redraw=async()=>{await page.getByRole("button",{name:"Close right panel"}).click();await expect(panel).toHaveCount(0);await goalButton.click();await expect(panel).toBeVisible()};
    const shoot=async(name,shown)=>{
      for(const mode of ["dark","light"]){await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);for(const width of [1280,700]){await page.setViewportSize({width,height:800});await shown.evaluate(node=>node.scrollIntoView({block:"center"}));await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-"+width+"x800.png"})}}
      await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    };
    // Starting… as the person sees it on the panel drawn again, without scrolling: all of it in the window, and above the goal's bar
    // pinned at the panel's foot, which toBeVisible and toBeInViewport take for in sight; shot as it is drawn.
    const startingInSight=async(way,name)=>{
      const starting=repair.getByRole("button",{name:"Starting…",exact:true});
      await expect.soft(starting,"the panel drawn again "+way+" has the repair's Starting… in sight").toBeInViewport({ratio:1});
      const box=await starting.boundingBox({timeout:2000}).catch(()=>null),barBox=await panel.locator(":scope>.goal-actions").boundingBox();
      expect.soft(Boolean(box&&barBox&&box.y+box.height<=barBox.y+0.5),"Starting… above the goal's bar "+way).toBe(true);
      const mode=await page.locator("html").getAttribute("data-mode");await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-"+page.viewportSize().width+"x800.png"});
    };
    await summary.click();
    // Refused: the panel drawn again says why, in view, and offers the repair again.
    let answer=harness.holdRepair();
    await repair.getByRole("button",{name:"Repair failed verification",exact:true}).click();
    await expect(repair.getByRole("button",{name:"Starting…",exact:true})).toBeDisabled();
    await expect.poll(()=>harness.repairRequests()).toBe(1);
    await redraw();
    await expect.soft(repair.getByRole("button",{name:"Starting…",exact:true}),"the panel drawn again draws Continuity state open, with the repair starting in sight").toBeVisible();
    await expect.soft(save,"and the goal's bar off meanwhile").toHaveAttribute("aria-disabled","true");
    await startingInSight("with the right panel closed and opened again","verification-repair-drawn-again-starting-in-sight");
    await shoot("verification-repair-drawn-again-starting",repair);
    // A build that draws it closed: the person opens it to go on.
    if(!await repair.isVisible())await summary.click();
    answer("The failed step's record could not be read");
    const refusal=panel.getByRole("alert").filter({hasText:"The failed step's record could not be read"});
    await expect(refusal,"the refusal is said on the panel drawn again").toBeVisible();await expect(refusal).toBeInViewport();
    await expect(repair.getByRole("button",{name:"Repair failed verification",exact:true})).toBeEnabled();
    await shoot("verification-repair-drawn-again-refused",refusal);
    // Started: the panel drawn again says the repair turn started, and holds Repair started, so the failure is not repaired twice.
    answer=harness.holdRepair();
    await repair.getByRole("button",{name:"Repair failed verification",exact:true}).click();
    await expect.poll(()=>harness.repairRequests()).toBe(2);
    await redraw();
    await expect.soft(repair.getByRole("button",{name:"Starting…",exact:true}),"the panel drawn again shows the repair starting").toBeVisible();
    await startingInSight("once more","verification-repair-drawn-again-starting-in-sight-again");
    // And back from Files in a window 700 wide, where the right panel lies over the chat, in light.
    await page.setViewportSize({width:700,height:800});await page.evaluate(()=>{document.documentElement.dataset.mode="light"});
    const tabs=page.getByTestId("right-panel").locator(".context-panel-tab-scroll");
    await tabs.getByRole("button",{name:"Files",exact:true}).click();await expect(panel).toHaveCount(0);await tabs.getByRole("button",{name:"Goal",exact:true}).click();await expect(panel).toBeVisible();
    await startingInSight("back from Files in a window 700 wide","verification-repair-drawn-again-starting-in-sight");
    await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});
    if(!await repair.isVisible())await summary.click();
    answer();
    await expect(panel.getByText("Repair turn started on this thread.",{exact:true}),"the panel drawn again says the repair turn started").toBeVisible();
    await expect(repair.getByRole("button",{name:"Repair started",exact:true})).toBeDisabled();
    await expect(refusal).toHaveCount(0);
    await shoot("verification-repair-drawn-again-started",repair);
    expect(harness.repairRequests(),"one repair for each press").toBe(2);
  }finally{await harness.close()}
});
