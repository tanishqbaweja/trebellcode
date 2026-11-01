import { test,expect } from "@playwright/test";
import { openCode1App,send,shots,stopButton } from "./opencode-relay-app.js";

// The plan of an OpenCode turn as a person reads it. OpenCode can cancel a todo, and a plan step has no cancelled status, so the window
// used to show a cancelled todo as a pending step, and a plan OpenCode had partly given up on never read as done. The real relay and
// OpenCode 1.x session run here against a fake OpenCode 1.x server (tests/fixtures/fake-opencode1-server.mjs).
test("an OpenCode plan leaves out the todos OpenCode cancelled, so it shows no pending step for them",async({page})=>{
  test.setTimeout(90_000);
  let release=()=>{};const finish=new Promise(resolve=>{release=resolve});
  await openCode1App(page,async({sessionID,emit})=>{
    emit({type:"todo.updated",properties:{sessionID,todos:[
      {id:"todo-settings",content:"Read the timezone from the settings file",status:"completed",priority:"medium"},
      {id:"todo-utc",content:"Hard-code UTC for the report",status:"cancelled",priority:"low"},
      {id:"todo-local",content:"Show each date in local time",status:"completed",priority:"high"},
    ]}});
    await finish;return "Report dates are in local time now.";
  },async()=>{
    await send(page,"The report shows every date in UTC");
    const plan=page.locator(".tool-event.kind-plan");
    await expect(plan).toHaveCount(2,{timeout:20_000});
    await expect(plan.locator("summary strong")).toHaveText(["Read the timezone from the settings file","Show each date in local time"]);
    await expect(plan.locator("summary em")).toHaveText(["done","done"]);
    await expect(page.locator(".tool-event.kind-plan.status-pending")).toHaveCount(0);
    await expect(page.getByText("Hard-code UTC for the report")).toHaveCount(0);
    await shots(page,"opencode-plan-cancelled-todo",()=>expect(plan.first()).toBeVisible());
    release();
    await expect(page.locator(".assistant-message-text").filter({hasText:"Report dates are in local time now."})).toBeVisible({timeout:20_000});
    await expect(stopButton(page)).toHaveCount(0);
  });
});
