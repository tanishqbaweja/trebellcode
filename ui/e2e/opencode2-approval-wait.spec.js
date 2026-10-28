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
