import { test,expect } from "@playwright/test";
import { auditDir,gate,startStreamingFixture,stop } from "./native-stream-fixture.js";

// Turn controls as a person uses them: a new task while another thread runs, Stop, the queue, Edit from here and Compact. The real
// agent relay runs the real Native session with a scripted provider (native-stream-fixture.js); a Codex app-server is faked where
// the turn id only arrives with Codex's own answers.
const untilAborted=signal=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(Object.assign(new Error("provider request aborted"),{name:"AbortError"})),{once:true}));
const reply=(request,text)=>({id:"turn-controls-"+Math.random().toString(36).slice(2,8),provider:request.provider,model:request.model,text,toolCalls:[],finishReason:"stop",usage:{inputTokens:12,outputTokens:40,totalTokens:52}});
// The last thing the person asked in a provider call. Each scripted call answers by what it was asked, so a call a stopped or
// removed thread still makes (its completion check) never takes the answer meant for the next task.
const askedIn=request=>{const user=(request.messages||[]).findLast(message=>message?.role==="user");return typeof user?.content==="string"?user.content:JSON.stringify(user?.content||"")};
const GATE_ANSWER=JSON.stringify({status:"complete",progress:"improved",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"The fixture turn did what it was asked."});
function answerBy(fixture,routes){
  const step=(request,hook)=>{
    if(request.metadata?.completionGate===true||request.responseJsonSchema?.name==="trebell_completion_gate")return reply(request,GATE_ANSWER);
    const asked=askedIn(request),route=routes.find(([text])=>asked.includes(text));return route?route[1](request,hook):reply(request,"Done.");
  };
  for(let index=0;index<20;index++)fixture.script.push(step);
}
const composer=page=>page.getByTestId("composer");
const threadRow=(page,name)=>page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${name}"]`)});
const newTask=page=>page.getByRole("button",{name:"New task",exact:true});
const IDLE_PLACEHOLDER="Ask Trebell Code anything…";

// The settings the header's light and dark toggle saves stay in the page, so the shared e2e server keeps its own.
async function keepSettings(page){
  const saved={};
  await page.route(/\/api\/settings$/,route=>{
    if(route.request().method()==="POST")Object.assign(saved,route.request().postDataJSON()||{});
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(saved)});
  });
}
// Types into the composer as a person does, a key at a time.
async function typeInComposer(page,text){await composer(page).click();await page.keyboard.type(text,{delay:8})}
async function sendTyped(page,text){await typeInComposer(page,text);await page.keyboard.press("Enter")}
// The header's light and dark toggle, or its row in More actions where the header folded it away.
async function toggleMode(page){
  const before=await page.locator("html").getAttribute("data-mode"),direct=page.locator("[data-testid=appearance-toggle]:visible").first();
  if(await direct.count())await direct.click();
  else{await page.getByRole("button",{name:/More actions/}).first().click();await page.getByRole("menuitem",{name:/Switch to (light|dark) mode/}).first().click()}
  await expect(page.locator("html")).not.toHaveAttribute("data-mode",before||"");
}
// Dark and light screenshots at 1280x800 and 900 wide, each mode switched with the header toggle, ending where it began.
async function shoot(page,name){
  for(const [width,height] of [[1280,800],[900,800]]){
    await page.setViewportSize({width,height});
    for(let pass=0;pass<2;pass++){
      const mode=await page.locator("html").getAttribute("data-mode");
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.screenshot({animations:"disabled",path:`${auditDir}turn-controls-${name}-${mode}-${width}x${height}.png`});
      await toggleMode(page);
    }
  }
  await page.setViewportSize({width:1280,height:800});
}
// A new-task view a person can use: no Stop, the composer's own placeholder and its pickers enabled.
async function expectIdleNewTask(page){
  await expect(page.locator(".workspace-header")).toContainText("New Trebell task");
  await expect(stop(page)).toHaveCount(0);
  await expect(composer(page)).toHaveAttribute("placeholder",IDLE_PLACEHOLDER);await expect(composer(page)).toBeEnabled();
  await expect(page.locator(".composer-wrap select:disabled")).toHaveCount(0);
  await expect(page.locator(".queued-message")).toHaveCount(0);
}

test("a new task while another thread's turn runs is idle and starts its own thread, and the running thread shows running in the sidebar and again when opened",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  await keepSettings(page);
  const fixture=await startStreamingFixture(page,{threads:[{name:"Long count",preview:"Counting"}]});
  const streamed=gate(),finish=gate();
  answerBy(fixture,[
    ["Count slowly",async(request,hook)=>{hook({type:"text",delta:"Counting slowly: one, two, three, four, five. "});streamed.open();await Promise.race([finish.promise,untilAborted(request.signal)]);return reply(request,"Counting slowly: one, two, three, four, five. Done counting.")}],
    ["one short sentence",async request=>reply(request,"The second task answered in a thread of its own.")]]);
  try{
    await fixture.open("Long count");
    await sendTyped(page,"Count slowly to twenty.");await streamed.promise;
    await expect(stop(page)).toBeVisible();
    await newTask(page).click();
    await expectIdleNewTask(page);
    // The thread left running still shows running in the sidebar.
    await expect(threadRow(page,"Long count").getByRole("img",{name:"Running"})).toBeVisible();
    await shoot(page,"new-task-while-another-runs");
    // Enter starts a thread of its own while the other turn goes on: no queue, the reply comes in that thread.
    await sendTyped(page,"Reply with one short sentence.");
    await expect(page.getByText("The second task answered in a thread of its own.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(page.locator(".queued-message")).toHaveCount(0);
    await expect(page.locator(".workspace-header")).not.toContainText("New Trebell task");
    expect(fixture.threadStore.list().length).toBe(2);
    await expect(threadRow(page,"Long count").getByRole("img",{name:"Running"})).toBeVisible();
    await expect(stop(page)).toHaveCount(0);
    // Opened again, the first thread is running, and its turn ends there.
    await threadRow(page,"Long count").locator(".thread-main").click();
    await expect(stop(page)).toBeVisible({timeout:10_000});await expect(composer(page)).toHaveAttribute("placeholder","Queue a follow-up…");
    finish.open();
    await expect(page.locator(".history-assistant").filter({hasText:"Done counting."})).toHaveCount(1,{timeout:10_000});
    await expect(stop(page)).toHaveCount(0);
  }finally{finish.open();await fixture.close()}
});

for(const action of ["Delete","Archive"]){
  test(`${action.toLowerCase()} of the open thread while its turn runs leaves an idle new task whose next prompt starts a thread`,async({page})=>{
    test.setTimeout(90_000);
    await page.setViewportSize({width:1280,height:800});
    await keepSettings(page);
    const fixture=await startStreamingFixture(page,{threads:[{name:"Fix login redirect",preview:"Login"},{name:"Keep this one",preview:"Other"}]});
    // The provider holds its answer past the removal, as a slow request does, so the turn still runs when its thread goes.
    const streamed=gate(),release=gate();
    answerBy(fixture,[
      ["login redirect",async(request,hook)=>{hook({type:"text",delta:"Looking at the login redirect now. "});streamed.open();await release.promise;return reply(request,"The redirect loops because the session cookie is dropped.")}],
      ["new task after",async request=>reply(request,"A new task after the "+action.toLowerCase()+" answered.")]]);
    try{
      await fixture.open("Fix login redirect");
      await sendTyped(page,"Find why the login redirect loops.");await streamed.promise;
      await expect(stop(page)).toBeVisible();
      const row=threadRow(page,"Fix login redirect");await row.hover();await row.locator(".thread-menu summary").click();
      if(action==="Delete")page.once("dialog",dialog=>dialog.accept());
      await row.getByRole("button",{name:action,exact:true}).click();
      await expect(threadRow(page,"Fix login redirect")).toHaveCount(0);
      await expectIdleNewTask(page);
      await shoot(page,`${action.toLowerCase()}-running-thread`);
      release.open();await page.waitForTimeout(300);await expectIdleNewTask(page);
      await sendTyped(page,"Start a new task after the "+action.toLowerCase()+".");
      await expect(page.getByText("A new task after the "+action.toLowerCase()+" answered.",{exact:true})).toBeVisible({timeout:15_000});
      await expect(page.locator(".queued-message")).toHaveCount(0);await expect(stop(page)).toHaveCount(0);
    }finally{release.open();await fixture.close()}
  });
}
