import { test,expect } from "@playwright/test";
import { openCode2App,send,shots,stopButton } from "./opencode-relay-app.js";

// An answer OpenCode 2 refuses, as a person sees it. Trebell sent the window an error notice for it, which the window takes for the
// end of the turn: an error row, the spinner and Stop gone and a desktop notification, while OpenCode still ran the turn. Now the
// refusal reaches the model and the question's own row (OpenCode fails its question tool with the reason Trebell cancels the question
// with), and the turn goes on to its reply. The row opened to the item's JSON, the reason its last field, below the box's fold and
// worded for the model; it opens to the question, the person's answer and OpenCode's reason. The real relay, OpenCode 2 session and
// @opencode/client run against the fake OpenCode 2 server, which refuses the answer as OpenCode 2.0.24 refuses one (FormInvalidAnswerError).
const REFUSED="Invalid option for form field: color";
const TOLD=`The user's answer could not be given: ${REFUSED}. Continue without it, and tell the user what you would need from them.`;
const SHOWN=`Which color should the theme use?\nAnswer: Ultraviolet\nOpenCode refused the answer (${REFUSED}), so the turn went on without it.`;
const ANSWER="That color could not be used, so the theme keeps its amber.";
const FORM="/api/session/ses_main/form/frm_pick";

test("an answer OpenCode 2 refuses shows on the question's row while the turn goes on, and the reply comes",async({page})=>{
  test.setTimeout(120_000);
  let release=()=>{};const finish=new Promise(resolve=>{release=resolve});
  await openCode2App(page,async({fake,sessionID,emit,reply:keep})=>{
    emit({type:"session.tool.input.started",data:{sessionID,id:"call_question",name:"question"}});
    emit({type:"form.created",data:{form:{id:"frm_pick",sessionID,title:"Questions",metadata:{kind:"question"},fields:[
      {key:"color",type:"string",title:"Color",description:"Which color should the theme use?",options:[{value:"amber",label:"Amber"}],custom:true},
    ]}}});
    // OpenCode fails its question tool with the message the question was cancelled with, and the model goes on.
    for(let waited=0;!fake.called(`DELETE ${FORM}`).length&&waited<600;waited++)await new Promise(resolve=>setTimeout(resolve,50));
    emit({type:"session.tool.failed",data:{sessionID,id:"call_question",error:{type:"unknown",message:fake.called(`DELETE ${FORM}`)[0]?.query?.message||""}}});
    await finish;keep(ANSWER);
    emit({type:"session.text.started",data:{sessionID,assistantMessageID:"msg_a1",ordinal:0}});
    emit({type:"session.text.delta",data:{sessionID,assistantMessageID:"msg_a1",delta:ANSWER}});
    emit({type:"session.execution.succeeded",data:{sessionID}});
  },async({fake})=>{
    const dialog=page.getByRole("dialog",{name:"Agent needs input"});
    await send(page,"Make me a theme");
    await expect(dialog).toBeVisible({timeout:20_000});
    await dialog.getByPlaceholder("Custom answer…").click();await page.keyboard.type("Ultraviolet",{delay:5});
    await dialog.getByRole("button",{name:"Submit"}).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(()=>fake.called(`DELETE ${FORM}`).map(call=>call.query.message),{message:"the model is told why"}).toEqual([TOLD]);
    // The question's row says it, and the turn is still OpenCode's: no error row, Stop still there.
    const row=page.locator(".tool-event").filter({hasText:/question/i});
    await expect(row).toHaveCount(1,{timeout:20_000});
    await row.locator("summary").click();
    const body=row.locator(".tool-event-body");
    await expect(body.locator("pre"),"the row opens to what was asked and answered, and why OpenCode refused it").toHaveJSProperty("textContent",SHOWN);
    await expect(body.locator(".tool-json"),"not the item's JSON").toHaveCount(0);await expect(body).not.toContainText("Continue without it");
    await expect(page.locator(".tool-event.kind-error")).toHaveCount(0);
    await expect(stopButton(page),"the turn goes on").toBeVisible();
    await shots(page,"opencode2-question-refused",()=>expect(body.locator("pre")).toHaveJSProperty("textContent",SHOWN));
    release();
    await expect(page.locator(".assistant-message-text").filter({hasText:ANSWER})).toBeVisible({timeout:20_000});
    await expect(stopButton(page)).toHaveCount(0);
    await expect(page.locator(".tool-event.kind-error")).toHaveCount(0);
    // The thread opened again after a reload shows the same row.
    await page.reload();await page.getByRole("button",{name:/Theme check/}).click();
    await expect(row).toHaveCount(1,{timeout:20_000});
    await row.locator("summary").press("Enter");
    await expect(body.locator("pre")).toHaveJSProperty("textContent",SHOWN);
  },{routes:{[`POST ${FORM}/reply`]:({send:answer})=>answer(400,{_tag:"FormInvalidAnswerError",message:REFUSED})}});
});
