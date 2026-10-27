import { test,expect } from "@playwright/test";
import { openCode2App,send,shots,stopButton } from "./opencode-relay-app.js";

// An OpenCode 2 turn whose event stream went silent, as a person sees it: OpenCode 2 sends a heartbeat every 15 seconds, so a stream
// that sent nothing for 45 seconds has stopped, and the turn waited on it for good (Stop showing, nothing coming). Now the turn ends
// saying so, and the next message goes through. The fake OpenCode 2 server here sends no heartbeat at all, and nothing for the first
// turn. The real relay, OpenCode 2 session and @opencode/client run against it (tests/fixtures/fake-opencode2-server.mjs).
const STOPPED="OpenCode's server sent nothing for 45 seconds, so Trebell stopped the turn. Send the message again to retry.";
const ANSWER="Hello again, the server answers now.";

test("an OpenCode 2 turn whose server sends nothing for 45 seconds ends saying so, and the next message goes through",async({page})=>{
  test.setTimeout(180_000);
  let turns=0;
  await openCode2App(page,({sessionID,emit,reply})=>{
    if(++turns===1)return;
    reply(ANSWER);
    emit({type:"session.text.started",data:{sessionID,assistantMessageID:"msg_a2",ordinal:0}});
    emit({type:"session.text.delta",data:{sessionID,assistantMessageID:"msg_a2",delta:ANSWER}});
    emit({type:"session.execution.succeeded",data:{sessionID}});
  },async({fake})=>{
    await send(page,"Say hello");
    await expect(stopButton(page),"the turn waits on OpenCode").toBeVisible({timeout:20_000});
    const stopped=page.locator(".tool-event.kind-error").filter({hasText:"sent nothing for 45 seconds"});
    await expect(stopped).toBeVisible({timeout:75_000});
    await expect(stopped.locator("summary strong")).toHaveText(STOPPED);
    await expect(stopButton(page)).toHaveCount(0);
    // Letting go of the stream is Trebell's own doing: @opencode/client's "Transport: This operation was aborted" is no error row.
    await expect(page.locator(".tool-event.kind-error").filter({hasText:"Transport"})).toHaveCount(0);
    // Trebell stopped the run on the server too, since it could no longer follow it.
    await expect.poll(()=>fake.called("POST /api/session/ses_main/interrupt").length).toBe(1);
    await shots(page,"opencode2-silent-stream-stopped",()=>expect(stopped).toBeVisible());
    await send(page,"Say hello again");
    await expect(page.locator(".assistant-message-text").filter({hasText:ANSWER}),"the session listens again").toBeVisible({timeout:20_000});
    await expect(stopButton(page)).toHaveCount(0);
  },{heartbeatMs:0});
});
