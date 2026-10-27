import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { routeCodexApp, startCodexHarness } from "./codex-history-harness.js";

// Codex retries a request that fails; when its retries run out it says why only with the last attempt's HTTP status
// (codexErrorInfo {responseTooManyFailedAttempts:{httpStatusCode}}). A turn whose retries ended on 429 hit a usage or rate limit
// (T3 Code 58b48274f): its card and the row it leaves say so and point the person to Usage, as a usage-limit failure does. One that
// ended on another status stays a plain error.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const exhausted=(status,text)=>({message:`exceeded retry limit, last status: ${status} ${text}`,codexErrorInfo:{responseTooManyFailedAttempts:{httpStatusCode:status}},additionalDetails:null});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

async function openThreadRow(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:10_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}
async function toggleMode(page){
  const before=await page.locator("html").getAttribute("data-mode"),direct=page.locator("[data-testid=appearance-toggle]:visible").first();
  if(await direct.count())await direct.click();
  else{await page.getByRole("button",{name:/More actions/}).first().click();await page.getByTestId("header-overflow-menu").getByRole("button",{name:/^Switch to (light|dark) mode$/}).click()}
  await expect(page.locator("html")).not.toHaveAttribute("data-mode",before||"");
}
// A screenshot in each mode at 1280x800, back in the mode it started in; ready() is what must show before each.
async function shoot(page,name,ready){
  for(let pass=0;pass<2;pass++){
    await ready();
    const mode=await page.locator("html").getAttribute("data-mode");
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({animations:"disabled",path:`${auditDir}codex-retry-limit-${name}-${mode}-1280x800.png`});
    await toggleMode(page);
  }
}

test("a Codex turn whose retries ran out on HTTP 429 says so with the Usage hint, live and on the row it leaves, and a 500 stays a plain error",async({page})=>{
  test.setTimeout(90_000);
  const thread={id:"codex-retry-limit",name:"Codex retry limit",preview:"Retries that ran out",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const limited=exhausted(429,"Too Many Requests"),failed=exhausted(500,"Internal Server Error");
  const limitedShown=limited.message+" · See Usage for your Codex limits.";
  // Codex's error notification, then turn/completed carrying the same error, as a turn whose retries ran out ends.
  const failWith=error=>(turn,{emit,threadId,finish})=>{emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});emit({method:"error",params:{threadId,turnId:turn.id,error,willRetry:false}});finish("failed",{error})};
  const harness=await startCodexHarness(thread,[failWith(limited),failWith(failed)]);
  try{
    await routeCodexApp(page,harness,thread);
    // The mode switch before each screenshot saves the appearance, which the app's settings answer with what was saved.
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");await openThreadRow(page,"Codex retry limit");
    const composer=page.getByTestId("composer"),cards=page.locator(".agent-block .tool-event.kind-error"),rows=page.getByTestId("turn-outcome-row");

    await composer.click();await page.keyboard.type("Run the release checks");await page.keyboard.press("Enter");
    await expect(cards.filter({hasText:limitedShown})).toBeVisible({timeout:15_000});
    await shoot(page,"usage-hint",()=>expect(cards.filter({hasText:limitedShown})).toBeVisible());

    // The next turn's retries end on 500: its card says only Codex's error. The first turn's row keeps the hint.
    await composer.click();await page.keyboard.type("Try the release checks again");await page.keyboard.press("Enter");
    await expect(cards.filter({hasText:failed.message})).toBeVisible({timeout:15_000});
    await expect(cards.filter({hasText:failed.message})).not.toContainText("See Usage");
    await expect(rows.locator(".turn-outcome-message").filter({hasText:limited.message})).toHaveText(limitedShown);
    await shoot(page,"after-500",()=>expect(rows.locator(".turn-outcome-message").filter({hasText:limited.message})).toBeVisible());
    expect(harness.calls.filter(call=>call.method==="turn/start")).toHaveLength(2);
  }finally{await harness.close()}
});
