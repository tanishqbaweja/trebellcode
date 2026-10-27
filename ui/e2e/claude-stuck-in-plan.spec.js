import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { claudeReply,routeClaudeApp,startClaudeRelay } from "./claude-relay-harness.js";

// Claude can switch itself to Plan mode. When Claude Code then refuses to leave it while background work it runs pins the process,
// the person's next message is refused, on the real relay with Claude Code's SDK scripted: the refusal says Claude Code is stuck in
// the Plan mode Claude chose and asks them to wait for that work, not that a model or setting change of theirs would end it.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const STUCK_IN_PLAN="Claude Code could not leave the Plan mode Claude switched to, and restarting it would end the background agents or commands it is still running. Wait for them to finish, then send the message again.";

async function openThread(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}
async function send(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:5});await page.getByTestId("send").click()}

test("a message to Claude Code stuck in the Plan mode Claude switched to, with background work running, is refused saying to wait for that work",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startClaudeRelay({
    // The first turn starts a watcher in the background and switches Claude to Plan mode, as EnterPlanMode does.
    turn:async({message,emit})=>{
      emit({type:"system",subtype:"background_tasks_changed",tasks:[{task_id:"bg-watch",description:"npm run watch",task_type:"local_bash"}]});
      emit({type:"system",subtype:"status",status:null,permissionMode:"plan"});
      for(const frame of claudeReply(message,"Started the watcher and switched to planning the fix."))emit(frame);
    },
    control:{setPermissionMode:mode=>{throw new Error(`Cannot set permission mode to ${mode} now`)}},
  });
  try{
    harness.seedThread("Watcher fix",{permissionProfile:"edits"});
    await routeClaudeApp(page,harness,{permissionMode:"edits"});
    await page.goto("/");await openThread(page,"Watcher fix");

    await send(page,"Start the watcher, then plan the fix");
    await expect(page.getByText("Started the watcher and switched to planning the fix.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:15_000});

    await send(page,"Now fix it");
    const refusal=page.locator(".agent-block .tool-event.kind-error").filter({hasText:"Plan mode"});
    await expect.soft(refusal,"the refusal names what holds the message back").toContainText(STUCK_IN_PLAN,{timeout:15_000});
    await expect.soft(page.getByText("this model or setting change would end them"),"no change of the person's is blamed").toHaveCount(0);
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-stuck-in-plan-refusal-${mode}-1280x800.png`});
    }
  }finally{await harness.close()}
});
