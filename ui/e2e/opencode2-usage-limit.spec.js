import { test,expect } from "@playwright/test";
import { openCode2App,send,shots,stopButton } from "./opencode-relay-app.js";

// An OpenCode 2 turn that a usage limit stopped, as a person sees it: OpenCode 2 types an OpenCode Go window or a budget that is used
// up as provider.quota (HTTP 429), and a rate limit as provider.rate-limit; the turn ended with OpenCode's words alone, nothing saying
// where to check the limit. An empty balance is provider.quota with HTTP 402, which never resets: it keeps OpenCode's own message. The
// real relay, OpenCode 2 session and @opencode/client run against a fake OpenCode 2 server (tests/fixtures/fake-opencode2-server.mjs).
const QUOTA="You have reached your OpenCode Go usage limit for this 5-hour window.";
const BALANCE="Insufficient balance. Add credits at https://opencode.ai/workspace/billing to keep going.";

test("an OpenCode 2 quota stop says to see Usage, and an empty balance keeps OpenCode's own message",async({page})=>{
  test.setTimeout(90_000);
  let turns=0;
  await openCode2App(page,({sessionID,emit})=>{
    const error=++turns===1?{type:"provider.quota",status:429,message:QUOTA}:{type:"provider.quota",status:402,message:BALANCE};
    emit({type:"session.execution.started",data:{sessionID}});
    emit({type:"session.execution.failed",data:{sessionID,error}});
  },async()=>{
    await send(page,"Refactor the parser");
    const limit=page.locator(".tool-event.kind-error").filter({hasText:QUOTA});
    await expect(limit).toBeVisible({timeout:20_000});
    await expect(limit.locator("summary strong")).toHaveText(`${QUOTA} See Usage for your OpenCode limits.`);
    await expect(stopButton(page)).toHaveCount(0);
    await shots(page,"opencode2-usage-limit",()=>expect(limit).toBeVisible());
    await send(page,"Try once more");
    const balance=page.locator(".tool-event.kind-error").filter({hasText:"Insufficient balance"});
    await expect(balance).toBeVisible({timeout:20_000});
    await expect(balance.locator("summary strong")).toHaveText(BALANCE);
    await shots(page,"opencode2-empty-balance",()=>expect(balance).toBeVisible());
  });
});
