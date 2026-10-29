import { test,expect } from "@playwright/test";
import { openCode2App,send,shots,stopButton } from "./opencode-relay-app.js";

// An OpenCode 2 turn whose event stream drops, as a person sees it. The real relay, OpenCode 2 session and @opencode/client run against
// the fake OpenCode 2 server (tests/fixtures/fake-opencode2-server.mjs), whose history OpenCode 2.0.24 keeps alike (live): each run's
// end is an idle item with its outcome, and a reply is the run's assistant messages. Trebell listens on a new stream and reads back from
// the turn's own message what OpenCode did meanwhile, as T3 Code does. It used to take OpenCode's newest assistant message as the
// answer, so a run lost meanwhile answered with the earlier turn's reply and a reply with text Trebell missed was shown twice; and a
// turn Trebell stopped following left OpenCode's run going, whose text and end the next turn took. A message refused while that run
// went on then stayed in the conversation as sent, its turn failed and the composer empty; and a turn whose run OpenCode lost read
// "stopped" with nothing saying why.
const ANSWER="The parser handles nested quotes now.";
const EARLIER="The earlier answer.";
const STILL_RUNNING="OpenCode was still running the turn Trebell stopped following, so Trebell stopped that run. Send the message again in a moment.";
const RUN_LOST="OpenCode lost this turn's run while Trebell was reconnecting to it, so the turn did not finish. Send the message again to retry.";
const later=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// A turn's reply: shown as it streams (.assistant-answer), and as the turn's message once it has ended (.assistant-message-text).
const replyText=page=>page.locator(".assistant-message-text"),streaming=page=>page.locator(".assistant-answer, .assistant-message-text");
const block=(emit,sessionID,id,delta)=>emit({type:"session.text.delta",data:{sessionID,assistantMessageID:id,ordinal:0,delta}});
const answer=(emit,sessionID,words,id)=>{
  emit({type:"session.text.started",data:{sessionID,assistantMessageID:id,ordinal:0}});block(emit,sessionID,id,words);
  emit({type:"session.execution.succeeded",data:{sessionID}});
};
const failure=send=>send(500,{_tag:"UnknownError",message:"Internal error"});

test("a message sent while OpenCode still runs the turn Trebell stopped following is not sent, its draft kept beside why, and that run is stopped; sent again, it shows only its own answer",async({page})=>{
  test.setTimeout(180_000);
  // OpenCode cannot say which sessions it runs while Trebell reconnects, and its interrupt does not take then. Once it does, the run
  // says its last words on its way out, which reach no turn.
  let failing=true;
  const routes={
    "GET /api/session/active":({send,active})=>failing?failure(send):send(200,{data:Object.fromEntries([...active].map(id=>[id,{type:"running"}]))}),
    "POST /api/session/ses_main/interrupt":({send,active,emit})=>{
      if(failing)return failure(send);
      const running=active.has("ses_main");if(running){block(emit,"ses_main","msg_a1"," The old run's words.");emit({type:"session.execution.interrupted",data:{sessionID:"ses_main",reason:"interrupt"}})}
      return send(200,{data:{interrupted:running}});
    },
  };
  await openCode2App(page,async({body,sessionID,emit,reply,fake})=>{
    // The message sent again once that run has stopped is answered.
    if(/again/.test(String(body?.text||""))){reply(ANSWER,"msg_a2");answer(emit,sessionID,ANSWER,"msg_a2");return}
    // OpenCode starts on the first message, and its event stream drops.
    emit({type:"session.text.started",data:{sessionID,assistantMessageID:"msg_a1",ordinal:0}});block(emit,sessionID,"msg_a1","Looking at the parser.");
    await expect(streaming(page).filter({hasText:"Looking at the parser."})).toBeVisible();
    fake.dropStreams();
  },async({fake,threadStore,threadId})=>{
    await send(page,"Fix the parser");
    const lost=page.locator(".tool-event.kind-error").filter({hasText:"did not say whether it still runs the turn"});
    await expect(lost,"the turn Trebell cannot follow again ends saying so").toBeVisible({timeout:90_000});
    expect(fake.called("POST /api/session/ses_main/interrupt").length,"Trebell tries to stop that run").toBeGreaterThanOrEqual(1);
    failing=false;
    await send(page,"Fix the parser again");
    // Not sent: as a send the harness refuses, the draft goes back to the composer with why beside it, and no bubble or turn is left of it.
    const alert=page.getByTestId("composer-alert");
    await expect(alert).toHaveText(`Not sent: ${STILL_RUNNING} Your draft is kept.`,{timeout:20_000});
    await expect(page.getByTestId("composer")).toHaveValue("Fix the parser again");
    await expect(page.locator(".user-bubble").filter({hasText:"Fix the parser again"}),"the message is not shown as sent").toHaveCount(0);
    await expect(page.locator(".tool-event.kind-error").filter({hasText:"still running the turn Trebell stopped following"})).toHaveCount(0);
    await expect(stopButton(page)).toHaveCount(0);
    expect(threadStore.get(threadId).turns,"the refused message has no turn in the thread").toHaveLength(1);
    expect(fake.prompts().length,"the message is not sent while OpenCode runs the last one").toBe(1);
    expect(fake.active.has("ses_main"),"the run still going is stopped").toBe(false);
    await shots(page,"opencode2-lost-stream-still-running",()=>expect(alert).toBeVisible());
    // In a moment the person sends the kept draft with Enter, and it is answered with its own words only.
    await page.getByTestId("composer").click();await page.keyboard.press("Enter");
    await expect(replyText(page).filter({hasText:ANSWER})).toBeVisible({timeout:20_000});
    await expect(stopButton(page)).toHaveCount(0);
    await expect(alert).toHaveCount(0);
    await expect(page.locator(".user-bubble").filter({hasText:"Fix the parser again"})).toHaveCount(1);
    await expect(page.getByText("The old run's words.")).toHaveCount(0);
    await expect(replyText(page).last()).toHaveText(ANSWER);
    expect(fake.prompts().map(prompt=>prompt.text.endsWith("Fix the parser again")),"the draft went once, as kept").toEqual([false,true]);
  },{heartbeatMs:0,routes});
});

test("an OpenCode 2 turn whose run was lost while its stream was down ends saying OpenCode lost the run, without the earlier turn's reply as its answer",async({page})=>{
  test.setTimeout(120_000);
  await openCode2App(page,async({body,sessionID,emit,reply,fake})=>{
    if(!/again/.test(String(body?.text||""))){reply(EARLIER,"msg_a1");answer(emit,sessionID,EARLIER,"msg_a1");return}
    // OpenCode starts on the second message; then its server loses the run (a restart) and the event stream drops. OpenCode keeps no
    // reply and no end for that run.
    emit({type:"session.text.started",data:{sessionID,assistantMessageID:"msg_a2",ordinal:0}});block(emit,sessionID,"msg_a2","Working on it.");
    await expect(streaming(page).filter({hasText:"Working on it."})).toBeVisible();
    fake.active.delete(sessionID);fake.dropStreams();
  },async({fake,threadStore,threadId})=>{
    await send(page,"Fix the parser");
    await expect(replyText(page).filter({hasText:EARLIER})).toBeVisible({timeout:20_000});
    await expect(stopButton(page)).toHaveCount(0);
    await send(page,"Fix the parser again");
    await expect(streaming(page).filter({hasText:"Working on it."})).toBeVisible({timeout:20_000});
    await expect(stopButton(page),"the turn ends once Trebell has read OpenCode's history").toHaveCount(0,{timeout:60_000});
    // Nobody stopped it: it failed, and its row says OpenCode lost the run, under what it had written.
    const row=page.locator(".tool-event.kind-error").filter({hasText:RUN_LOST});
    await expect(row,"the turn says OpenCode lost its run").toBeVisible();
    await expect(page.getByTestId("turn-outcome").last()).toContainText("failed");
    expect(threadStore.get(threadId).turns[1]?.error?.message).toBe(RUN_LOST);
    await expect(replyText(page).filter({hasText:EARLIER}),"the earlier turn's reply is not shown again").toHaveCount(1);
    await expect(replyText(page).last()).toHaveText("Working on it.");
    expect(fake.called("GET /api/session/ses_main/message").length,"Trebell read OpenCode's history").toBeGreaterThanOrEqual(2);
    await shots(page,"opencode2-lost-stream-run-lost",()=>expect(row).toBeVisible());
  },{heartbeatMs:0});
});

test("an OpenCode 2 turn whose run goes on while its stream is down shows what OpenCode wrote meanwhile in its place, and its reply once",async({page})=>{
  test.setTimeout(120_000);
  await openCode2App(page,async({sessionID,emit,reply,fake})=>{
    emit({type:"session.text.started",data:{sessionID,assistantMessageID:"msg_a1",ordinal:0}});block(emit,sessionID,"msg_a1","The parser ");
    await expect(streaming(page).filter({hasText:"The parser"})).toBeVisible();
    // The stream drops while the model writes on, and OpenCode keeps what it wrote.
    reply("The parser handles nested","msg_a1");
    const read=fake.called("GET /api/session/ses_main/message").length;fake.dropStreams();
    for(let waited=0;fake.called("GET /api/session/ses_main/message").length===read&&waited<400;waited++)await later(50);
    await expect(streaming(page).filter({hasText:"The parser handles nested"})).toBeVisible().catch(()=>{});
    // The new stream sends on: part of the text OpenCode had kept already, the rest, then the block's end with its whole text.
    block(emit,sessionID,"msg_a1"," nested");block(emit,sessionID,"msg_a1"," quotes now.");
    emit({type:"session.text.ended",data:{sessionID,assistantMessageID:"msg_a1",ordinal:0,text:ANSWER}});
    reply(ANSWER,"msg_a1");emit({type:"session.execution.succeeded",data:{sessionID}});
  },async({fake})=>{
    await send(page,"Fix the parser");
    await expect(stopButton(page),"the turn goes on to its end").toHaveCount(0,{timeout:60_000});
    await expect(replyText(page).last()).toHaveText(ANSWER);
    expect(fake.called("GET /api/event").length,"Trebell listened on a new stream").toBeGreaterThanOrEqual(2);
    await expect(page.locator(".tool-event.kind-error")).toHaveCount(0);
    await shots(page,"opencode2-lost-stream-backfilled",()=>expect(replyText(page).last()).toHaveText(ANSWER));
  },{heartbeatMs:0});
});
