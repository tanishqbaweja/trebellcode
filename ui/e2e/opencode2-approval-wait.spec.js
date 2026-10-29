import { test,expect } from "@playwright/test";
import { openCode2App,send,shots,stopButton } from "./opencode-relay-app.js";

// An approval a person takes more than 45 seconds over on a Supervised OpenCode 2 thread, as they see it: the turn waits on the
// person, not on a stream gone silent, so allowing the command lets the turn go on, with no "sent nothing for 45 seconds" stop and no
// interrupt of the command just allowed. @opencode/client reads OpenCode's event stream in the background and reports its heartbeats
// (every 15 s, as the fake server sends them) while the session waits on the person. A guard: the code before the repair kept such a
// turn too. The real relay, OpenCode 2 session and @opencode/client run against the fake OpenCode 2 server
// (tests/fixtures/fake-opencode2-server.mjs).
const ANSWER="The tests pass.";
const PERMISSION="/api/session/ses_main/permission/per_tests/reply";

test("an OpenCode 2 approval allowed after 50 seconds lets the turn go on to its answer, with no stop and no interrupt",async({page})=>{
  test.setTimeout(180_000);
  await openCode2App(page,async({fake,sessionID,emit,reply:keep})=>{
    emit({type:"permission.asked",data:{id:"per_tests",sessionID,action:"shell",resources:["npm test"],save:[],metadata:{command:"npm test"}}});
    for(let waited=0;!fake.called(`POST ${PERMISSION}`).length&&waited<3000;waited++)await new Promise(resolve=>setTimeout(resolve,50));
    keep(ANSWER);
    emit({type:"session.text.started",data:{sessionID,assistantMessageID:"msg_a1",ordinal:0}});
    emit({type:"session.text.delta",data:{sessionID,assistantMessageID:"msg_a1",delta:ANSWER}});
    emit({type:"session.execution.succeeded",data:{sessionID}});
  },async({fake})=>{
    // The person works Supervised: OpenCode asks before it runs a command.
    await page.locator("select").filter({has:page.locator("option",{hasText:"Supervised"})}).selectOption({label:"Supervised"});
    await send(page,"Run the tests");
    const card=page.locator(".inline-approval .approval-card");
    await expect(card).toBeVisible({timeout:20_000});
    // The person reads it for 50 seconds before allowing it; OpenCode's heartbeat comes every 15 seconds meanwhile.
    await page.waitForTimeout(50_000);
    await expect(card).toBeVisible();await expect(page.locator(".tool-event.kind-error")).toHaveCount(0);
    await shots(page,"opencode2-approval-after-50s",()=>expect(card).toBeVisible());
    await card.getByRole("button",{name:"Allow once",exact:true}).click();
    await expect.poll(()=>fake.called(`POST ${PERMISSION}`).map(call=>call.body?.decision)).toEqual(["once"]);
    await expect(page.locator(".assistant-message-text").filter({hasText:ANSWER}),"the turn goes on").toBeVisible({timeout:20_000});
    await expect(page.locator(".tool-event.kind-error")).toHaveCount(0);
    await expect(stopButton(page)).toHaveCount(0);
    expect(fake.called("POST /api/session/ses_main/interrupt"),"the allowed command is not interrupted").toHaveLength(0);
  },{routes:{[`POST ${PERMISSION}`]:({send:answer})=>answer(204)}});
});

// An approval the person leaves unanswered until the relay stops waiting for it (five minutes), as they see it. Before, the card just
// left the window and OpenCode was told the person declined the command, so the model went on and the turn ended done with nothing
// saying the approval had not been answered. Now, as for a question left unanswered, the turn ends saying so, and OpenCode gets a reject
// without a message, which stops its run.
const DEPLOY="/api/session/ses_main/permission/per_deploy/reply";
const UNANSWERED="OpenCode's shell request (npm run deploy) was not answered in time, so Trebell declined it and stopped the turn.";

test("an OpenCode 2 approval left unanswered until the relay stops waiting ends the turn saying it was not answered in time, and OpenCode is told to stop, not that the person declined it",async({page})=>{
  test.setTimeout(120_000);
  // The relay waits five minutes for the person's answer: the test runs that wait, the relay's one five-minute timer, in eight seconds.
  const realSetTimeout=globalThis.setTimeout;
  globalThis.setTimeout=(callback,ms,...rest)=>realSetTimeout(callback,ms===5*60_000?8_000:ms,...rest);
  try{
    await openCode2App(page,({sessionID,emit})=>{
      emit({type:"permission.asked",data:{id:"per_deploy",sessionID,action:"shell",resources:["npm run deploy"],save:[],metadata:{command:"npm run deploy"}}});
    },async({fake,threadStore,threadId})=>{
      await page.locator("select").filter({has:page.locator("option",{hasText:"Supervised"})}).selectOption({label:"Supervised"});
      await send(page,"Deploy the docs site");
      const card=page.locator(".inline-approval .approval-card");
      await expect(card).toBeVisible({timeout:20_000});
      await expect(card).toContainText("npm run deploy");
      // The person leaves it: the card goes once the relay stops waiting, and the turn ends saying why.
      await expect(card).toHaveCount(0,{timeout:30_000});
      const row=page.locator(".tool-event.kind-error").filter({hasText:UNANSWERED});
      await expect(row,"the window says the approval was not answered in time").toBeVisible({timeout:20_000});
      await expect(stopButton(page)).toHaveCount(0);
      await expect.poll(()=>threadStore.get(threadId).turns[0]?.status,{message:"the turn ends"}).toBe("failed");
      expect(threadStore.get(threadId).turns[0].error?.message).toBe(UNANSWERED);
      // OpenCode got a reject without a message, its stop, and no note that the person declined the command.
      expect(fake.called(`POST ${DEPLOY}`).map(call=>call.body)).toEqual([{decision:"reject"}]);
      expect(fake.called("POST /api/session/ses_main/synthetic"),"no steer tells the model it was declined").toHaveLength(0);
      await expect(page.getByText("The command was not approved, so I did not run it.")).toHaveCount(0);
      await shots(page,"opencode2-approval-unanswered",()=>expect(row).toBeVisible());
      // The thread opened again after a reload says so too.
      await page.reload();
      await page.getByRole("button",{name:/Theme check/}).click();
      await expect(page.getByText(UNANSWERED).first()).toBeVisible({timeout:20_000});
    },{routes:{[`POST ${DEPLOY}`]:({send:answer,body,emit})=>{
      answer(204);
      // As OpenCode takes the reply: a reject with a message fails the command's tool and the model goes on; one without stops the run.
      if(!body?.message){emit({type:"session.execution.interrupted",data:{sessionID:"ses_main",reason:"rejected"}});return}
      emit({type:"session.text.started",data:{sessionID:"ses_main",assistantMessageID:"msg_a1",ordinal:0}});
      emit({type:"session.text.delta",data:{sessionID:"ses_main",assistantMessageID:"msg_a1",delta:"The command was not approved, so I did not run it."}});
      emit({type:"session.execution.succeeded",data:{sessionID:"ses_main"}});
    }}});
  }finally{globalThis.setTimeout=realSetTimeout}
});
