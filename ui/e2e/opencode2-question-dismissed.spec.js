import { test,expect } from "@playwright/test";
import { openCode2App,send,shots,stopButton } from "./opencode-relay-app.js";

// An OpenCode 2 question the person closes without answering, as they see it. Before, Trebell told the model to continue without the
// answer, and the turn ran on as if nothing had been asked. Now the question is cancelled as T3 Code cancels it (no message), which
// OpenCode takes as the person dismissing it and stops its run, and the turn ends saying why. The real relay, OpenCode 2 session and
// @opencode/client run against the fake OpenCode 2 server (tests/fixtures/fake-opencode2-server.mjs).
const DISMISSED="OpenCode's question was dismissed, so Trebell declined it and stopped the turn.";

test("an OpenCode 2 question the person cancels or closes ends the turn saying so, and OpenCode is told to stop rather than go on",async({page})=>{
  test.setTimeout(120_000);
  let asked=0;
  await openCode2App(page,({sessionID,emit})=>{
    emit({type:"form.created",data:{form:{id:`frm_color_${++asked}`,sessionID,title:"Questions",metadata:{kind:"question"},fields:[
      {key:"color",type:"string",title:"Color",description:"Which color should the theme use?",options:[{value:"amber",label:"Amber"},{value:"blue",label:"Blue"}],custom:true},
    ]}}});
  },async({fake,threadStore,threadId})=>{
    const dialog=page.getByRole("dialog",{name:"Agent needs input"});
    // The dialog's Cancel, then its close button: both answer with no answers.
    const ways=[["Make me a theme",()=>dialog.getByRole("button",{name:"Cancel",exact:true}).click()],["Try once more",()=>dialog.getByRole("button",{name:"Close question"}).click()]];
    for(const [index,[message,close]] of ways.entries()){
      await send(page,message);
      await expect(dialog).toBeVisible({timeout:20_000});
      await expect(dialog).toContainText("Which color should the theme use?");
      await close();
      await expect(dialog).toHaveCount(0);
      // The turn ends, failed with the reason, which its error row says (and then its summary, once the next turn starts).
      await expect.poll(()=>threadStore.get(threadId).turns[index]?.status,{message:"the turn ends",timeout:20_000}).toBe("failed");
      expect(threadStore.get(threadId).turns[index].error?.message).toBe(DISMISSED);
      await expect(page.locator(".tool-event.kind-error").filter({hasText:DISMISSED}).last()).toBeVisible();
      await expect(stopButton(page)).toHaveCount(0);
      // OpenCode got a cancel without a message, its stop, not a message telling the model to go on.
      await expect.poll(()=>fake.called(`DELETE /api/session/ses_main/form/frm_color_${index+1}`).map(call=>call.query)).toEqual([{}]);
    }
    await expect(page.getByTestId("composer")).toBeEnabled();
    await shots(page,"opencode2-question-dismissed",()=>expect(page.locator(".tool-event.kind-error").filter({hasText:DISMISSED}).last()).toBeVisible());
  });
});
