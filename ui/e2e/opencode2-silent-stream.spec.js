import { test,expect } from "@playwright/test";
import { openCode2App,send,shots,stopButton } from "./opencode-relay-app.js";

// An OpenCode 2 turn whose event stream went silent, as a person sees it. OpenCode 2 sends a heartbeat every 15 seconds, so a stream
// that sent nothing for 45 seconds is lost. Trebell ended the turn then and interrupted OpenCode's run, even when OpenCode still ran it
// and answered at once. Now, as T3 Code does, Trebell listens on a new stream and asks OpenCode whether it still runs the turn: the turn
// goes on and its answer shows, and only a turn Trebell cannot follow again ends, saying so. The fake OpenCode 2 server here sends no
// heartbeat; the real relay, OpenCode 2 session and @opencode/client run against it (tests/fixtures/fake-opencode2-server.mjs).
const ANSWER="The parser handles nested quotes now.";
const UNKNOWN="Trebell lost OpenCode's event stream, and OpenCode did not say whether it still runs the turn, so Trebell stopped following it. Send the message again to retry.";
const later=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const answer=(emit,sessionID,words,id)=>{
  emit({type:"session.text.started",data:{sessionID,assistantMessageID:id,ordinal:0}});
  emit({type:"session.text.delta",data:{sessionID,assistantMessageID:id,delta:words}});
  emit({type:"session.execution.succeeded",data:{sessionID}});
};

test("an OpenCode 2 turn whose event stream goes silent while OpenCode still runs it goes on once Trebell listens again, and its answer shows",async({page})=>{
  test.setTimeout(180_000);
  await openCode2App(page,async({fake,sessionID,emit,reply})=>{
    // OpenCode works on, but its stream sends nothing until Trebell listens on a new one.
    for(let waited=0;fake.called("GET /api/event").length<2&&waited<2400;waited++)await later(50);
    for(let waited=0;!fake.called("GET /api/session/active").length&&waited<200;waited++)await later(50);
    reply(ANSWER);answer(emit,sessionID,ANSWER,"msg_a1");
  },async({fake})=>{
    await send(page,"Fix the parser");
    await expect(stopButton(page),"the turn waits on OpenCode").toBeVisible({timeout:20_000});
    const reply=page.locator(".assistant-message-text").filter({hasText:ANSWER});
    await expect(reply,"the turn goes on once Trebell listens again").toBeVisible({timeout:90_000});
    expect(fake.called("GET /api/event").length).toBeGreaterThanOrEqual(2);
    await expect(stopButton(page)).toHaveCount(0);
    await expect(page.locator(".tool-event.kind-error"),"no error row, Transport or other").toHaveCount(0);
    expect(fake.called("POST /api/session/ses_main/interrupt"),"OpenCode's run is not stopped").toHaveLength(0);
    await shots(page,"opencode2-silent-stream-followed",()=>expect(reply).toBeVisible());
  },{heartbeatMs:0});
});

test("an OpenCode 2 turn whose stream went silent and whose server does not say it still runs it ends saying so, and the next message goes through",async({page})=>{
  test.setTimeout(180_000);
  let turns=0;
  await openCode2App(page,({sessionID,emit,reply})=>{
    if(++turns===1)return;
    reply(ANSWER);answer(emit,sessionID,ANSWER,"msg_a2");
  },async({fake})=>{
    await send(page,"Fix the parser");
    await expect(stopButton(page),"the turn waits on OpenCode").toBeVisible({timeout:20_000});
    const stopped=page.locator(".tool-event.kind-error").filter({hasText:"did not say whether it still runs the turn"});
    await expect(stopped).toBeVisible({timeout:90_000});
    await expect(stopped.locator("summary strong")).toHaveText(UNKNOWN);
    await expect(stopButton(page)).toHaveCount(0);
    // Letting go of the stream is Trebell's own doing, and no error row of its own.
    await expect(page.locator(".tool-event.kind-error").filter({hasText:"Transport"})).toHaveCount(0);
    expect(fake.called("POST /api/session/ses_main/interrupt"),"a run Trebell cannot see is not stopped blind").toHaveLength(0);
    await shots(page,"opencode2-silent-stream-stopped",()=>expect(stopped).toBeVisible());
    await send(page,"Fix the parser again");
    await expect(page.locator(".assistant-message-text").filter({hasText:ANSWER}),"the session listens again").toBeVisible({timeout:20_000});
    await expect(stopButton(page)).toHaveCount(0);
  },{heartbeatMs:0,routes:{"GET /api/session/active":({send:respond})=>respond(500,{_tag:"UnknownError",message:"Internal error"})}});
});
