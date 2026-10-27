import { test,expect } from "@playwright/test";
import { openCode1App,send,shots,stopButton } from "./opencode-relay-app.js";

// An OpenCode turn's plan as a person sees it: OpenCode's todo list can cancel a step, which a plan step cannot be, so the window
// showed it as pending, and a plan whose last steps OpenCode gave up never read as done. The real relay and OpenCode 1.x session run
// against a fake OpenCode 1.x server (tests/fixtures/fake-opencode1-server.mjs).
test("an OpenCode plan leaves out the todos OpenCode cancelled, so it shows no pending step for them",async({page})=>{
  test.setTimeout(90_000);
  let release=()=>{};const finish=new Promise(resolve=>{release=resolve});
  await openCode1App(page,async({sessionID,emit})=>{
    emit({type:"todo.updated",properties:{sessionID,todos:[
      {content:"Write the fix",status:"completed",priority:"high"},
      {content:"Try another approach",status:"cancelled",priority:"medium"},
      {content:"Add a regression test",status:"completed",priority:"medium"},
    ]}});
    await finish;return "The fix and its test are in.";
  },async()=>{
    await send(page,"Fix the failing build");
    const plan=page.locator(".tool-event.kind-plan");
    await expect(plan).toHaveCount(2,{timeout:20_000});
    await expect(plan.locator("summary strong")).toHaveText(["Write the fix","Add a regression test"]);
    await expect(plan.locator("summary em")).toHaveText(["done","done"]);
    await expect(page.locator(".tool-event.kind-plan.status-pending")).toHaveCount(0);
    await expect(page.getByText("Try another approach")).toHaveCount(0);
    await shots(page,"opencode-plan-cancelled-todo",()=>expect(plan.first()).toBeVisible());
    release();
    await expect(page.locator(".assistant-message-text").filter({hasText:"The fix and its test are in."})).toBeVisible({timeout:20_000});
    await expect(stopButton(page)).toHaveCount(0);
  });
});
