import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { claudeReply,routeClaudeApp,startClaudeRelay } from "./claude-relay-harness.js";

// Claude can switch itself to Plan mode. When Claude Code then refuses to leave it while background work it runs pins the process,
// the person's next message is refused, on the real relay with Claude Code's SDK scripted: the refusal says Claude Code is stuck in
// the Plan mode Claude chose, not that a model or setting change of theirs would end that work, and names the two ways on: wait for
// the work, or end it now with Edit from here on the message. A watcher never ends by itself: Edit from here ends it with the Claude
// Code it runs in, and the message sent again goes, in a new Claude Code at the thread's mode.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const STUCK_IN_PLAN="Claude Code could not leave the Plan mode Claude switched to, and restarting it would end the background agents or commands it is still running. Wait for them to finish, then send the message again. To end them now, choose Edit from here on this message and send it again.";

async function openThread(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}
async function send(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:5});await page.getByTestId("send").click()}
// The page as it is, then in the other appearance.
async function shootBoth(page,name){
  const html=page.locator("html"),first=await html.getAttribute("data-mode"),other=first==="dark"?"light":"dark";
  await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${first}-1280x800.png`});
  await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(html).toHaveAttribute("data-mode",other);
  await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${other}-1280x800.png`});
}

test("a message to Claude Code stuck in the Plan mode Claude switched to, with a watcher running, is refused saying how to go on, and Edit from here ends the watcher and sends it",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  // The watcher runs as long as the first Claude Code does; a later Claude Code notes the mode it runs in.
  const watcher={ended:false},modes=[];
  const harness=await startClaudeRelay({
    turn:async({message,emit,signal,options,query})=>{
      if(query===0){
        // The first turn starts a watcher in the background and switches Claude to Plan mode, as EnterPlanMode does.
        signal.addEventListener("abort",()=>{watcher.ended=true},{once:true});
        emit({type:"system",subtype:"background_tasks_changed",tasks:[{task_id:"bg-watch",description:"npm run watch",task_type:"local_bash"}]});
        emit({type:"system",subtype:"status",status:null,permissionMode:"plan"});
        for(const frame of claudeReply(message,"Started the watcher and switched to planning the fix."))emit(frame);
        return;
      }
      modes.push(options.permissionMode);
      for(const frame of claudeReply(message,"Fixed the crash the watcher showed."))emit(frame);
    },
    control:{setPermissionMode:mode=>{throw new Error(`Cannot set permission mode to ${mode} now`)}},
  });
  try{
    const thread=harness.seedThread("Watcher fix",{permissionProfile:"edits"});
    await routeClaudeApp(page,harness,{permissionMode:"edits"});
    await page.goto("/");await openThread(page,"Watcher fix");
    const composer=page.getByTestId("composer");

    await send(page,"Start the watcher, then plan the fix");
    await expect(page.getByText("Started the watcher and switched to planning the fix.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:15_000});

    await send(page,"Now fix it");
    const refusal=page.locator(".agent-block .tool-event.kind-error").filter({hasText:"Plan mode"});
    await expect.soft(refusal,"the refusal names what holds the message back, and how to go on").toContainText(STUCK_IN_PLAN,{timeout:15_000});
    await expect.soft(page.getByText("this model or setting change would end them"),"no change of the person's is blamed").toHaveCount(0);
    // The watcher's row on the first turn's card agrees with the refusal: the watcher still runs.
    const card=page.locator(`[data-testid=activity-card][data-turn-id="${harness.threadStore.get(thread.id).turns[0].id}"]`);
    const watcherRow=card.locator(".tool-event").filter({has:page.locator("summary strong",{hasText:/^npm run watch/})});
    const openCard=async()=>{if(await card.getAttribute("data-state")!=="open")await card.locator(".activity-card-head").click()};
    await openCard();
    await expect.soft(watcherRow.locator("summary em"),"the watcher's row says it still runs, as the refusal does").toHaveText("running");
    await shootBoth(page,"claude-stuck-in-plan-refusal");
    expect(watcher.ended,"the refusal leaves the watcher running").toBe(false);

    // The way on the refusal names: Edit from here on the message ends the watcher with its Claude Code, and the message goes again.
    await page.locator(".user-bubble").filter({hasText:"Now fix it"}).getByRole("button",{name:"Edit from here",exact:true}).click();
    await page.getByRole("dialog").getByRole("button",{name:"Edit from here",exact:true}).click();
    await expect(composer).toHaveValue("Now fix it",{timeout:15_000});
    await expect(composer).toBeFocused({timeout:15_000});
    await expect.poll(()=>watcher.ended,{message:"the watcher ended with its Claude Code"}).toBe(true);
    await expect(refusal,"the refused message's turn went with Edit from here").toHaveCount(0);
    // The watcher's row says it ended, with its Claude Code.
    await openCard();
    await expect.soft(watcherRow.locator("summary strong"),"the watcher's row says how it ended").toHaveText("npm run watch: Claude Code stopped before this finished.");
    await expect.soft(watcherRow.locator("summary em")).toHaveText("failed");
    await page.getByTestId("send").click();
    await expect(page.getByText("Fixed the crash the watcher showed.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:15_000});
    await expect(page.getByText(STUCK_IN_PLAN),"the message is not refused again").toHaveCount(0);
    expect(modes,"one new Claude Code, at the thread's Auto-accept edits").toEqual(["acceptEdits"]);
    await shootBoth(page,"claude-stuck-in-plan-edit-from-here");
  }finally{await harness.close()}
});

// A watcher Claude Code runs in the background runs past the turn that started it: the row it has on that turn's card reads running
// through the person's next messages, a reload and the thread opened again, until Claude Code no longer lists it, and then done there,
// on no other card. The thread is in Auto, which this model's Claude Code opened in Manual: every follow-up runs in that one process.
test("a watcher Claude Code runs in the background reads running on the card of the turn that started it until Claude Code says it ended, through the next message and a reload, then done there",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  let claudeCode=null;
  const harness=await startClaudeRelay({
    turn:async({message,index,emit})=>{
      if(index===0){claudeCode=emit;emit({type:"system",subtype:"background_tasks_changed",tasks:[{task_id:"bg-watch",description:"npm run watch",task_type:"local_bash"}]})}
      for(const frame of claudeReply(message,["Started the watcher.","Ran the tests."][index]||"Done."))emit(frame);
    },
    control:{init:()=>({permissionMode:"default"}),setPermissionMode:mode=>{if(mode==="auto")throw new Error("Auto mode is unavailable for this model")}},
  });
  try{
    const thread=harness.seedThread("Watcher auto",{permissionProfile:"auto"});
    await routeClaudeApp(page,harness,{permissionMode:"auto"});
    await page.goto("/");await openThread(page,"Watcher auto");
    const stop=page.getByRole("button",{name:"Stop",exact:true});
    await send(page,"Start the watcher");
    await expect(page.getByText("Started the watcher.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(stop).toHaveCount(0,{timeout:15_000});
    // Soft, so that the old code also shows what the row says at each step.
    const started=harness.threadStore.get(thread.id).turns[0].id,card=page.locator(`[data-testid=activity-card][data-turn-id="${started}"]`);
    const watcher=card.locator(".tool-event").filter({has:page.locator("summary strong",{hasText:/^npm run watch$/})});
    const open=async()=>{await expect(card).toHaveCount(1);if(await card.getAttribute("data-state")!=="open")await card.locator(".activity-card-head").click()};
    await open();
    await expect.soft(watcher.locator("summary em"),"the watcher runs on past the turn that started it").toHaveText("running");
    await expect.soft(watcher.locator("summary .timeline-marker svg.lucide-check"),"with no check").toHaveCount(0);
    await send(page,"And now the tests");
    await expect(page.getByText("Ran the tests.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(stop).toHaveCount(0,{timeout:15_000});
    await open();
    await expect.soft(watcher.locator("summary em"),"still running past the next message").toHaveText("running");
    await expect.soft(page.locator(".tool-event").filter({hasText:"npm run watch"}),"on that card only").toHaveCount(1);
    await watcher.scrollIntoViewIfNeeded();await shootBoth(page,"claude-background-watcher-runs-past-turn");
    // The window reloaded and the thread opened again: the card, rebuilt from the thread's history, has the watcher still running.
    await page.reload();await openThread(page,"Watcher auto");
    await expect(page.getByText("Ran the tests.",{exact:true})).toBeVisible({timeout:15_000});
    await open();
    await expect.soft(watcher.locator("summary em"),"still running after a reload").toHaveText("running");
    // Claude Code no longer lists the watcher: it ended, and its row settles on its turn's card.
    claudeCode({type:"system",subtype:"background_tasks_changed",tasks:[]});
    await expect(watcher.locator("summary em"),"its end settles it there").toHaveText("done",{timeout:15_000});
    await expect(page.locator(".tool-event").filter({hasText:"npm run watch"}),"on that card only").toHaveCount(1);
    await page.reload();await openThread(page,"Watcher auto");
    await expect(page.getByText("Ran the tests.",{exact:true})).toBeVisible({timeout:15_000});
    await open();
    await expect(watcher.locator("summary em"),"done after a reload too").toHaveText("done");
    await expect(page.locator(".tool-event").filter({hasText:"npm run watch"})).toHaveCount(1);
  }finally{await harness.close()}
});
