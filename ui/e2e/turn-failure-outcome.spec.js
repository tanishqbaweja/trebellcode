import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mkdir,mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { ContextEngine } from "../../src/context-engine.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";
import { routeCodexApp, startCodexHarness } from "./codex-history-harness.js";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));
mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const frames=(page,count)=>page.evaluate(total=>new Promise(resolve=>{let left=total;const tick=()=>--left>0?requestAnimationFrame(tick):resolve();requestAnimationFrame(tick)}),count);
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

// A provider's usage-limit failure as a harness reports it: long, with an unbroken URL that has to wrap.
const USAGE_LIMIT="Usage limit reached. Try again later. API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model gpt-5.6 for now. Usage resets over a rolling 24-hour window, tokens (actual/limit): 608078/600000. Upgrade for higher limits: https://example.invalid/account/upgrade/subscription-plans/0123456789abcdef0123456789abcdef0123456789abcdef";
const SIZES=[[1180,800],[1280,800],[1600,980]];

async function openThreadRow(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}

// The outcome rows read whole at every size and in both modes: nothing wider than the conversation column or the window, and
// every row in its column. Saves one screenshot per size and mode.
async function auditOutcomeRows(page,name,rows){
  for(const mode of ["dark","light"]){
    await page.evaluate(value=>{document.documentElement.dataset.mode=value},mode);
    for(const [width,height] of SIZES){
      await page.setViewportSize({width,height});await frames(page,3);
      await rows.last().scrollIntoViewIfNeeded();await frames(page,3);
      const fit=await page.evaluate(()=>{
        const column=document.querySelector(".conversation-column").getBoundingClientRect(),shell=document.querySelector(".workspace-shell");
        const parts=[...document.querySelectorAll("[data-testid=turn-outcome-row],[data-testid=turn-outcome-row] *")].map(node=>({node,rect:node.getBoundingClientRect()}));
        return {
          shellOverflow:shell.scrollWidth-shell.clientWidth,
          outside:parts.filter(({rect})=>rect.width&&(rect.left<column.left-1||rect.right>column.right+1)).map(({node})=>node.className||node.tagName),
          clipped:parts.filter(({node})=>node.scrollWidth>node.clientWidth+1&&getComputedStyle(node).overflowX!=="visible").map(({node})=>node.className||node.tagName),
        };
      });
      expect(fit,`${name} ${mode} ${width}x${height}`).toEqual({shellOverflow:0,outside:[],clipped:[]});
      await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${width}x${height}.png`});
    }
  }
  await page.evaluate(()=>{document.documentElement.dataset.mode="dark"});await page.setViewportSize({width:1600,height:980});
}

// Where a row sits on screen, for reading order across the activity card's reordering.
const box=async locator=>{const value=await locator.boundingBox();expect(value).toBeTruthy();return value};

test("a relay turn that failed without a reply says how it ended once the next turn starts, after a reload and reopened from history",async({page})=>{
  test.setTimeout(90_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-turn-failure-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"native-turn-failure",model:"gpt-5.6",name:"Native turn failure",preview:"A failed turn, then a good one",
    providerMeta:{runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"supervised",projectless:false,environmentId:null}});
  let providerCalls=0;
  const nativeProviderTurn=async request=>{
    providerCalls++;
    // The first turn fails at once, as a provider's usage limit does (not retried); the next one answers.
    if(providerCalls===1){await new Promise(resolve=>setTimeout(resolve,150));throw Object.assign(new Error(USAGE_LIMIT),{status:429,retryable:false})}
    return {id:"turn-failure-answer",provider:request.provider,model:request.model,text:"Second turn answer.",toolCalls:[],finishReason:"stop",usage:{}};
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"turn-failure-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"turn-failure-project",name:"Turn Failure Project",path:repo,environmentId:null,effectiveSettings:{}};
  let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  const turnRequests=[];
  try{
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"turn-failure-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:{[thread.id]:uiMeta}}));
    await page.route(/\/api\/models$/,route=>json(route,{models:["gpt-5.6"],metadata:{provider:"agentrouter",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"agentrouter",agent:"Trebell Native"}]}}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{project}:{projects:[project]}));
    await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST")uiMeta={...uiMeta,...(route.request().postDataJSON()?.patch||{})};await json(route,uiMeta)});
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{id:"turn-failure-checkpoint",threadId:thread.id}:{checkpoints:[]}));
    await page.route(/\/api\/checkpoints\/link$/,route=>json(route,{ok:true}));
    await page.route(/\/api\/context\/packet$/,route=>json(route,{id:"turn-failure-context",skipped:true,budget:{reserveTokens:1024}}));
    await page.route(/\/api\/verification\/plan-turn$/,route=>json(route,{supported:false}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    page.on("websocket",socket=>socket.on("framesent",frame=>{try{const message=JSON.parse(String(frame.payload));if(message?.method==="thread/turns/list")turnRequests.push(message.params)}catch{}}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");await openThreadRow(page,"Native turn failure");

    const composer=page.getByTestId("composer"),rows=page.getByTestId("turn-outcome-row");
    await composer.fill("First request, which hits the usage limit");await page.getByTestId("send").click();
    const cardError=page.locator(".agent-block .tool-event.kind-error").filter({hasText:"Usage limit reached"});
    await expect(cardError).toBeVisible({timeout:15_000});await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0);
    // The card lists the failure while it is on screen, so the conversation does not list it a second time.
    await expect(rows).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:auditDir+"turn-failure-relay-card-dark-1600x980.png"});

    await composer.fill("Second request");await page.getByTestId("send").click();
    await expect(page.getByText("Second turn answer.",{exact:true})).toBeVisible({timeout:15_000});
    // The failed turn now ends with its outcome row: the heading its reply would have had, the pill, the failure's message.
    await expect(rows).toHaveCount(1);
    const row=rows.first();
    await expect(row.getByTestId("assistant-heading")).toHaveText("Trebell Native · Supervised");
    await expect(row.getByTestId("turn-outcome")).toHaveText(/^failed · \d/);
    await expect(row.locator(".turn-outcome-message")).toHaveText(USAGE_LIMIT);
    // It sits between the failed turn's message and the next one, and the good turn keeps its pill under its reply.
    const first=page.locator(".user-row").filter({hasText:"First request, which hits the usage limit"}),second=page.locator(".user-row").filter({hasText:"Second request"});
    const [firstBox,rowBox,secondBox]=[await box(first),await box(row),await box(second)];
    expect(rowBox.y).toBeGreaterThanOrEqual(firstBox.y+firstBox.height-1);expect(rowBox.y+rowBox.height).toBeLessThanOrEqual(secondBox.y+1);
    const reply=page.locator(".history-assistant:not([data-testid=turn-outcome-row])").filter({hasText:"Second turn answer."});
    await expect(reply.getByTestId("turn-outcome")).toHaveText(/^done · /);await expect(page.locator(".conversation-history [data-testid=turn-outcome]")).toHaveCount(2);
    await auditOutcomeRows(page,"turn-failure-relay-live",rows);

    // A reload opens the thread on item pages, which say nothing of how a turn ended: the turn metadata beside them does.
    await page.reload();await openThreadRow(page,"Native turn failure");
    await expect(page.getByText("Second turn answer.",{exact:true})).toBeVisible({timeout:10_000});
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByTestId("assistant-heading")).toHaveText("Trebell Native");
    await expect(rows.first().getByTestId("turn-outcome")).toHaveText(/^failed/);
    await expect(rows.first().locator(".turn-outcome-message")).toHaveText(USAGE_LIMIT);
    expect(turnRequests.some(params=>params?.itemsView==="notLoaded"&&params?.sortDirection==="desc")).toBe(true);
    await auditOutcomeRows(page,"turn-failure-relay-reloaded",rows);

    // Reopened from the History page after another task, it still says so.
    await page.locator(".sidebar-utility[aria-label='New task']").click();await expect(rows).toHaveCount(0);
    await page.locator(".sidebar-utility[aria-label='History']").click();
    await page.locator(".history-thread-row").filter({hasText:"Native turn failure"}).click();
    await expect(page.getByText("Second turn answer.",{exact:true})).toBeVisible({timeout:10_000});
    await expect(rows).toHaveCount(1);await expect(rows.first().locator(".turn-outcome-message")).toHaveText(USAGE_LIMIT);
    await page.screenshot({animations:"disabled",path:auditDir+"turn-failure-relay-history-reopened-dark-1600x980.png"});
    expect(providerCalls).toBe(2);
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});

test("Codex turns that failed or were stopped without a reply keep their outcome rows live and after a reload",async({page})=>{
  test.setTimeout(90_000);
  const thread={id:"codex-turn-failure",name:"Codex turn failure",preview:"Failed, stopped, then answered",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const failure={message:"You've hit your usage limit. Upgrade to Pro or try again in 2 hours.",codexErrorInfo:"usageLimitExceeded",additionalDetails:null};
  const shown=failure.message+" · See Usage for your Codex limits.";
  const harness=await startCodexHarness(thread,[
    // Fails with Codex's error notification, then turn/completed carrying the same error.
    (turn,{emit,threadId,finish})=>{emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});emit({method:"error",params:{threadId,turnId:turn.id,error:failure,willRetry:false}});finish("failed",{error:failure})},
    // Runs a command until the person stops it.
    (turn,{emit,threadId,finish,onInterrupt})=>{
      emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});
      const command={id:"cmd-"+turn.id,type:"commandExecution",command:"npm test",cwd:process.cwd(),status:"inProgress",aggregatedOutput:"",exitCode:null};
      turn.items.push(command);emit({method:"item/started",params:{threadId,turnId:turn.id,item:command}});
      onInterrupt(()=>{Object.assign(command,{status:"declined"});emit({method:"item/completed",params:{threadId,turnId:turn.id,item:command}});finish("interrupted")});
    },
    (turn,{emit,threadId,finish})=>{
      emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});
      const answer={id:"agent-"+turn.id,type:"agentMessage",text:"Third turn answer."};turn.items.push(answer);
      emit({method:"item/completed",params:{threadId,turnId:turn.id,item:answer}});finish("completed");
    },
  ]);
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Codex turn failure");

    const composer=page.getByTestId("composer"),rows=page.getByTestId("turn-outcome-row");
    await composer.fill("Codex first request");await page.getByTestId("send").click();
    await expect(page.locator(".agent-block .tool-event.kind-error").filter({hasText:shown})).toBeVisible({timeout:10_000});
    await expect(rows).toHaveCount(0);

    // A stopped turn: the card lists its steps but not the stop, so its row (pill alone, no message is known) reads under the card.
    await composer.fill("Codex second request");await page.getByTestId("send").click();
    const stop=page.getByRole("button",{name:"Stop",exact:true});await expect(stop).toBeVisible({timeout:10_000});
    await expect(page.locator(".agent-block .tool-event").filter({hasText:"npm test"})).toBeVisible();await stop.click();
    await expect(stop).toHaveCount(0,{timeout:10_000});
    await expect(rows).toHaveCount(2);
    const failed=rows.filter({has:page.locator(".turn-outcome.tone-err")}),stopped=rows.filter({has:page.locator(".turn-outcome.tone-warn")});
    // Live, the time is the one this window measured; after a reload it is the harness's own.
    await expect(failed.getByTestId("turn-outcome")).toHaveText(/^failed · \d/);await expect(failed.locator(".turn-outcome-message")).toHaveText(shown);
    await expect(failed.getByTestId("assistant-heading")).toHaveText("Codex · Supervised");
    await expect(stopped.getByTestId("turn-outcome")).toHaveText(/^stopped/);await expect(stopped.locator(".turn-outcome-message")).toHaveCount(0);
    const card=page.locator(".agent-block");const [cardBox,stoppedBox]=[await box(card),await box(stopped)];
    expect(stoppedBox.y).toBeGreaterThanOrEqual(cardBox.y+cardBox.height-1);
    await page.screenshot({animations:"disabled",path:auditDir+"turn-failure-codex-stopped-under-card-dark-1600x980.png"});

    await composer.fill("Codex third request");await page.getByTestId("send").click();
    await expect(page.getByText("Third turn answer.",{exact:true})).toBeVisible({timeout:10_000});
    await expect(rows).toHaveCount(2);await expect(failed.locator(".turn-outcome-message")).toHaveText(shown);
    await auditOutcomeRows(page,"turn-failure-codex-live",rows);

    await page.reload();await openThreadRow(page,"Codex turn failure");
    await expect(page.getByText("Third turn answer.",{exact:true})).toBeVisible({timeout:10_000});
    await expect(rows).toHaveCount(2);
    await expect(failed.getByTestId("turn-outcome")).toHaveText("failed · 2.1s");await expect(failed.locator(".turn-outcome-message")).toHaveText(shown);
    await expect(failed.getByTestId("assistant-heading")).toHaveText("Codex");
    await expect(stopped.getByTestId("turn-outcome")).toHaveText("stopped · 2.1s");await expect(stopped.locator(".turn-outcome-message")).toHaveCount(0);
    // The answered turn's reply has its done pill after the reload too: the outcome pages beside the item pages carry it.
    const answered=page.locator(".history-assistant:not([data-testid=turn-outcome-row])").filter({hasText:"Third turn answer."});
    await expect(answered.getByTestId("turn-outcome")).toHaveText("done · 2.1s");await expect(page.locator(".conversation-history .turn-outcome.tone-ok")).toHaveCount(1);
    await auditOutcomeRows(page,"turn-failure-codex-reloaded",rows);
  }finally{await harness.close()}
});

test("older item pages read how their turns ended from turn pages read on just as far as those turns",async({page})=>{
  test.setTimeout(60_000);
  const thread={id:"codex-older-failures",name:"Codex older failures",preview:"Old failures under newer answers",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-600,updatedAt:Date.now()/1000,turns:[]};
  const failure={message:"You've hit your usage limit. Upgrade to Pro or try again in 2 hours.",codexErrorInfo:"usageLimitExceeded",additionalDetails:null};
  const startedAt=Math.floor(Date.now()/1000)-300;
  const turn=(n,text,reply,ended={status:"completed"})=>({id:"older-turn-"+n,startedAt:startedAt+n*10,completedAt:startedAt+n*10+2,durationMs:2100,error:null,...ended,
    items:[{id:"older-user-"+n,type:"userMessage",content:[{type:"text",text}]},...(reply?[{id:"older-agent-"+n,type:"agentMessage",text:reply}]:[])]});
  // Two turns of items to a page and one turn to a page of outcomes, so each older item page needs outcome pages read on.
  const harness=await startCodexHarness(thread,[],{pageTurns:2,outcomeTurns:1,seed:[
    turn(1,"Oldest request","Oldest answer."),
    turn(2,"Failing request",null,{status:"failed",error:failure}),
    turn(3,"Stopped request",null,{status:"interrupted"}),
    turn(4,"Middle request","Middle answer."),
    turn(5,"Newest request","Newest answer."),
  ]});
  const outcomeCursors=[];
  try{
    await routeCodexApp(page,harness,thread);
    page.on("websocket",socket=>socket.on("framesent",frame=>{try{const message=JSON.parse(String(frame.payload));if(message?.method==="thread/turns/list"&&message.params?.itemsView==="notLoaded")outcomeCursors.push(message.params.cursor)}catch{}}));
    await page.goto("/");await openThreadRow(page,"Codex older failures");
    const rows=page.getByTestId("turn-outcome-row"),userRow=text=>page.locator(".user-row").filter({hasText:text});
    await expect(page.getByText("Newest answer.",{exact:true})).toBeVisible({timeout:10_000});await expect(page.getByText("Middle answer.",{exact:true})).toBeVisible();
    await expect(userRow("Failing request")).toHaveCount(0);await expect(rows).toHaveCount(0);expect(outcomeCursors).toEqual(["turns@0"]);

    // The next item page holds the stopped and the failed turn: outcome pages are read on until both are covered, and no further.
    await page.getByRole("button",{name:"Load earlier messages",exact:true}).click();
    await expect(userRow("Failing request")).toBeVisible({timeout:10_000});await expect(rows).toHaveCount(2);
    expect(outcomeCursors).toEqual(["turns@0","turns@1","turns@2","turns@3"]);
    const failed=rows.filter({has:page.locator(".turn-outcome.tone-err")}),stopped=rows.filter({has:page.locator(".turn-outcome.tone-warn")});
    await expect(failed.getByTestId("assistant-heading")).toHaveText("Codex");await expect(failed.getByTestId("turn-outcome")).toHaveText("failed · 2.1s");
    await expect(failed.locator(".turn-outcome-message")).toHaveText(failure.message+" · See Usage for your Codex limits.");
    await expect(stopped.getByTestId("turn-outcome")).toHaveText("stopped · 2.1s");await expect(stopped.locator(".turn-outcome-message")).toHaveCount(0);
    // Each row closes its own turn: under that turn's message, above the next turn's.
    const [failing,failedBox,stopping,stoppedBox,middle]=[await box(userRow("Failing request")),await box(failed),await box(userRow("Stopped request")),await box(stopped),await box(userRow("Middle request"))];
    expect(failedBox.y).toBeGreaterThanOrEqual(failing.y+failing.height-1);expect(failedBox.y+failedBox.height).toBeLessThanOrEqual(stopping.y+1);
    expect(stoppedBox.y).toBeGreaterThanOrEqual(stopping.y+stopping.height-1);expect(stoppedBox.y+stoppedBox.height).toBeLessThanOrEqual(middle.y+1);
    await failed.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+"turn-failure-codex-older-pages-dark-1600x980.png"});

    // The oldest page's turn answered: one more outcome page, no new row, and each answered turn's reply has its done pill.
    await page.getByRole("button",{name:"Load earlier messages",exact:true}).click();
    await expect(page.getByText("Oldest answer.",{exact:true})).toBeVisible({timeout:10_000});
    expect(outcomeCursors).toEqual(["turns@0","turns@1","turns@2","turns@3","turns@4"]);
    await expect(rows).toHaveCount(2);await expect(page.locator(".conversation-history .turn-outcome.tone-ok")).toHaveCount(3);
    for(const answer of ["Oldest answer.","Middle answer.","Newest answer."])await expect(page.locator(".history-assistant:not([data-testid=turn-outcome-row])").filter({hasText:answer}).getByTestId("turn-outcome")).toHaveText("done · 2.1s");
  }finally{await harness.close()}
});

// Row a sits below row b on screen.
async function expectBelow(a,b){const [upper,lower]=[await box(b),await box(a)];expect(lower.y).toBeGreaterThanOrEqual(upper.y+upper.height-1)}

test("a goal turn that fails before any item, a stop after a denial and a code-only error each end with their row, live and after a reload",async({page})=>{
  test.setTimeout(90_000);
  const thread={id:"codex-goal-failure",name:"Codex goal failure",preview:"A goal hits the usage limit",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const usage={message:"You have hit your usage limit. Try again in 3 hours.",codexErrorInfo:"usageLimitExceeded",additionalDetails:null},usageShown=usage.message+" · See Usage for your Codex limits.";
  const unauthorized={message:"",codexErrorInfo:"unauthorized",additionalDetails:null},unauthorizedShown="Agent error · Sign in to Codex again from Agents & models, or run codex login.";
  const harness=await startCodexHarness(thread,[
    // The goal's first step answers, then Codex goes on by itself and its first request hits the usage limit: no item at all.
    (turn,{emit,threadId,finish,startOwnTurn})=>{
      emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});
      const answer={id:"agent-"+turn.id,type:"agentMessage",text:"Goal step one done."};turn.items.push(answer);
      emit({method:"item/completed",params:{threadId,turnId:turn.id,item:answer}});finish("completed");
      setTimeout(()=>startOwnTurn((own,tools)=>{tools.emit({method:"error",params:{threadId,turnId:own.id,error:usage,willRetry:false}});tools.finish("failed",{error:usage})}),200);
    },
    // Codex could not sign in: an error code with no text.
    (turn,{emit,threadId,finish})=>{emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});emit({method:"error",params:{threadId,turnId:turn.id,error:unauthorized,willRetry:false}});finish("failed",{error:unauthorized})},
    // An auto review denies a command, then the person stops the turn.
    (turn,{emit,threadId,finish,onInterrupt})=>{
      emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});
      const command={id:"cmd-"+turn.id,type:"commandExecution",command:"rm generated.tmp",cwd:process.cwd(),status:"inProgress",aggregatedOutput:"",exitCode:null},action={type:"command",command:"rm generated.tmp",cwd:process.cwd()},at=Date.now();
      turn.items.push(command);emit({method:"item/started",params:{threadId,turnId:turn.id,item:command}});
      emit({method:"item/autoApprovalReview/started",params:{threadId,turnId:turn.id,startedAtMs:at,reviewId:"review-"+turn.id,targetItemId:command.id,review:{status:"inProgress",riskLevel:null,userAuthorization:null,rationale:null},action}});
      emit({method:"item/autoApprovalReview/completed",params:{threadId,turnId:turn.id,startedAtMs:at,completedAtMs:at+50,reviewId:"review-"+turn.id,targetItemId:command.id,decisionSource:"agent",review:{status:"denied",riskLevel:"high",userAuthorization:"low",rationale:"Deleting this file needs explicit user approval."},action}});
      onInterrupt(()=>{Object.assign(command,{status:"declined"});emit({method:"item/completed",params:{threadId,turnId:turn.id,item:command}});finish("interrupted")});
    },
    (turn,{emit,threadId,finish})=>{
      emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});
      const answer={id:"agent-"+turn.id,type:"agentMessage",text:"Last answer."};turn.items.push(answer);
      emit({method:"item/completed",params:{threadId,turnId:turn.id,item:answer}});finish("completed");
    },
  ]);
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Codex goal failure");
    const composer=page.getByTestId("composer"),rows=page.getByTestId("turn-outcome-row"),stop=page.getByRole("button",{name:"Stop",exact:true}),card=page.locator(".agent-block");
    const rowOf=turnId=>page.locator(`[data-testid=turn-outcome-row][data-turn-id="${turnId}"]`),userRow=text=>page.locator(".user-row").filter({hasText:text});
    const reply=page.locator(".history-assistant:not([data-testid=turn-outcome-row])").filter({hasText:"Goal step one done."});
    await composer.fill("Codex goal request");await page.getByTestId("send").click();
    await expect(page.getByText("Goal step one done.",{exact:true})).toBeVisible({timeout:10_000});
    await expect(card.locator(".tool-event.kind-error").filter({hasText:usageShown})).toBeVisible({timeout:10_000});await expect(stop).toHaveCount(0,{timeout:10_000});
    // The card lists the goal turn's failure while it is on screen: no row repeats it.
    await expect(rows).toHaveCount(0);
    await page.screenshot({animations:"disabled",path:auditDir+"turn-failure-goal-card-dark-1600x980.png"});

    // Once the card moves on, the goal turn ends after the turn before it, above the next message.
    await composer.fill("Codex unauthorized request");await page.getByTestId("send").click();
    const goalRow=rowOf("codex-turn-2");
    await expect(goalRow).toBeVisible({timeout:10_000});
    await expect(goalRow.getByTestId("assistant-heading")).toHaveText("Codex");await expect(goalRow.getByTestId("turn-outcome")).toHaveText(/^failed · \d/);
    await expect(goalRow.locator(".turn-outcome-message")).toHaveText(usageShown);
    await expectBelow(goalRow,reply);await expectBelow(userRow("Codex unauthorized request"),goalRow);
    await expect(card.locator(".tool-event.kind-error").filter({hasText:unauthorizedShown})).toBeVisible({timeout:10_000});await expect(stop).toHaveCount(0,{timeout:10_000});

    // The code-only failure keeps the card's wording once the card moves on.
    await composer.fill("Codex denied request");await page.getByTestId("send").click();
    await expect(rowOf("codex-turn-3").locator(".turn-outcome-message")).toHaveText(unauthorizedShown,{timeout:10_000});
    // The denial is on the card, the stop is not: the stopped row reads below the card while it is on screen.
    await expect(stop).toBeVisible({timeout:10_000});await expect(card.locator(".tool-event").filter({hasText:"denied"})).toBeVisible({timeout:10_000});
    await stop.click();await expect(stop).toHaveCount(0,{timeout:10_000});
    const stoppedRow=rowOf("codex-turn-4");
    await expect(stoppedRow.getByTestId("turn-outcome")).toHaveText(/^stopped · \d/);await expect(stoppedRow.locator(".turn-outcome-message")).toHaveCount(0);
    await expectBelow(stoppedRow,card);
    await page.screenshot({animations:"disabled",path:auditDir+"turn-failure-denied-stopped-under-card-dark-1600x980.png"});

    await composer.fill("Codex last request");await page.getByTestId("send").click();
    await expect(page.getByText("Last answer.",{exact:true})).toBeVisible({timeout:10_000});
    await expect(rows).toHaveCount(3);expect(await rows.evaluateAll(nodes=>nodes.map(node=>node.dataset.turnId))).toEqual(["codex-turn-2","codex-turn-3","codex-turn-4"]);
    await goalRow.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+"turn-failure-goal-row-live-dark-1600x980.png"});
    await auditOutcomeRows(page,"turn-failure-goal-live",rows);

    // After a reload the goal turn, which has no item to page through, is placed from the turn pages beside the item pages.
    await page.reload();await openThreadRow(page,"Codex goal failure");
    await expect(page.getByText("Last answer.",{exact:true})).toBeVisible({timeout:10_000});
    await expect(rows).toHaveCount(3);expect(await rows.evaluateAll(nodes=>nodes.map(node=>node.dataset.turnId))).toEqual(["codex-turn-2","codex-turn-3","codex-turn-4"]);
    await expect(goalRow.getByTestId("turn-outcome")).toHaveText("failed · 2.1s");await expect(goalRow.locator(".turn-outcome-message")).toHaveText(usageShown);
    await expectBelow(goalRow,reply);await expectBelow(userRow("Codex unauthorized request"),goalRow);
    await expect(rowOf("codex-turn-3").locator(".turn-outcome-message")).toHaveText(unauthorizedShown);
    await expect(stoppedRow.getByTestId("turn-outcome")).toHaveText("stopped · 2.1s");
    await goalRow.scrollIntoViewIfNeeded();await page.screenshot({animations:"disabled",path:auditDir+"turn-failure-goal-row-reloaded-dark-1600x980.png"});
    await auditOutcomeRows(page,"turn-failure-goal-reloaded",rows);
  }finally{await harness.close()}
});

test("a turn the harness runs again after a restart ends with the error of its last run, not the first",async({page})=>{
  test.setTimeout(60_000);
  const thread={id:"codex-turn-again",name:"Codex turn again",preview:"Recovered, then failed",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const note={message:"Trebell restarted while this turn was running. Recovery is queued."},real={message:"Could not continue after restart: provider refused the session."};
  const harness=await startCodexHarness(thread,[
    // The relay's restart recovery: the turn ends interrupted with a note, starts again under the same id, and fails.
    (turn,{emit,threadId,finish})=>{
      emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});finish("interrupted",{error:note});
      setTimeout(()=>{
        Object.assign(turn,{status:"inProgress",error:null,completedAt:null,durationMs:null});emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});
        setTimeout(()=>{emit({method:"error",params:{threadId,turnId:turn.id,error:real,willRetry:false}});finish("failed",{error:real})},200);
      },400);
    },
    (turn,{emit,threadId,finish})=>{
      emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});
      const answer={id:"agent-"+turn.id,type:"agentMessage",text:"Second answer."};turn.items.push(answer);
      emit({method:"item/completed",params:{threadId,turnId:turn.id,item:answer}});finish("completed");
    },
  ]);
  try{
    await routeCodexApp(page,harness,thread);
    await page.goto("/");await openThreadRow(page,"Codex turn again");
    const composer=page.getByTestId("composer"),rows=page.getByTestId("turn-outcome-row");
    await composer.fill("Recovered request");await page.getByTestId("send").click();
    await expect(page.locator(".agent-block .tool-event.kind-error").filter({hasText:real.message})).toBeVisible({timeout:10_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:10_000});await expect(rows).toHaveCount(0);
    await composer.fill("Next request");await page.getByTestId("send").click();
    await expect(page.getByText("Second answer.",{exact:true})).toBeVisible({timeout:10_000});
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByTestId("turn-outcome")).toHaveText(/^failed · \d/);await expect(rows.first().locator(".turn-outcome-message")).toHaveText(real.message);
    await page.screenshot({animations:"disabled",path:auditDir+"turn-failure-run-again-live-dark-1600x980.png"});
    await page.reload();await openThreadRow(page,"Codex turn again");
    await expect(page.getByText("Second answer.",{exact:true})).toBeVisible({timeout:10_000});
    await expect(rows).toHaveCount(1);await expect(rows.first().locator(".turn-outcome-message")).toHaveText(real.message);
  }finally{await harness.close()}
});

test("a relay wake turn that failed before any item keeps its row after a reload, also when it opens the thread",async({page})=>{
  test.setTimeout(60_000);
  const root=await mkdtemp(join(tmpdir(),"trebell-wake-failure-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  const providerMeta={runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"supervised",projectless:false,environmentId:null};
  const wakeError="Claude Code could not authenticate. Run claude login, then try again.";
  // A user turn and its answer, then (wake) a turn of the harness's own with no item at all, failed as the relay stores it.
  const seed=(name,turns)=>{
    const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"wake-"+name,model:"gpt-5.6",name,preview:name,providerMeta});
    for(const [index,step] of turns.entries()){
      const turn=threadStore.addTurn(thread.id,{inputText:step.user||"",items:step.reply?[{type:"agentMessage",id:"answer-"+name.length+"-"+index,text:step.reply}]:[]});
      threadStore.finishTurn(thread.id,turn.id,step.reply?{status:"completed"}:{status:"failed",error:{message:wakeError}});
    }
    return thread;
  };
  const middle=seed("Wake failure between",[{user:"Start the background check",reply:"Started it in the background."},{},{user:"Anything new?",reply:"Nothing new yet."}]);
  const opening=seed("Wake failure first",[{},{user:"What happened?",reply:"The background check could not sign in."}]);
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn:async()=>{throw new Error("No turn runs in this test.")},version:"wake-failure-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  const project={id:"wake-failure-project",name:"Wake Failure Project",path:repo,environmentId:null,effectiveSettings:{}};
  const uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"};
  try{
    await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,cwd:repo,platform:process.platform,version:"wake-failure-fixture",activeEnvironmentId:null,activeEnvironment:null}));
    await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:{[middle.id]:uiMeta,[opening.id]:uiMeta}}));
    await page.route(/\/api\/models$/,route=>json(route,{models:["gpt-5.6"],metadata:{provider:"agentrouter",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"agentrouter",agent:"Trebell Native"}]}}));
    await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{project}:{projects:[project]}));
    await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
    await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]}));
    await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>json(route,uiMeta));
    await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,{checkpoints:[]}));
    await page.route(/\/api\/verification\/plan-turn$/,route=>json(route,{supported:false}));
    await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
    await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
    await page.goto("/");
    const rows=page.getByTestId("turn-outcome-row"),userRow=text=>page.locator(".user-row").filter({hasText:text});
    await openThreadRow(page,"Wake failure between");
    await expect(page.getByText("Nothing new yet.",{exact:true})).toBeVisible({timeout:10_000});
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByTestId("assistant-heading")).toHaveText("Trebell Native");await expect(rows.first().getByTestId("turn-outcome")).toHaveText(/^failed/);
    await expect(rows.first().locator(".turn-outcome-message")).toHaveText(wakeError);
    await expectBelow(rows.first(),page.locator(".history-assistant:not([data-testid=turn-outcome-row])").filter({hasText:"Started it in the background."}));
    await expectBelow(userRow("Anything new?"),rows.first());
    await page.screenshot({animations:"disabled",path:auditDir+"turn-failure-wake-between-dark-1600x980.png"});
    // A thread that opens with the wake turn starts with its row, above the first message.
    await openThreadRow(page,"Wake failure first");
    await expect(page.getByText("The background check could not sign in.",{exact:true})).toBeVisible({timeout:10_000});
    await expect(rows).toHaveCount(1);await expect(rows.first().locator(".turn-outcome-message")).toHaveText(wakeError);
    await expectBelow(userRow("What happened?"),rows.first());
    await page.screenshot({animations:"disabled",path:auditDir+"turn-failure-wake-first-dark-1600x980.png"});
  }finally{await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
