import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { claudeReply,routeClaudeApp,startClaudeRelay } from "./claude-relay-harness.js";

// Claude Code turn errors as a person reads them, on the real relay with Claude Code's SDK scripted: a full context says to run
// /compact or start a new thread instead of sending them to wait for a usage reset (or showing the reply's own "Prompt is too long"),
// a quick retry into a usage limit still says when it resets, although Claude Code sends that window only on the reply the limit
// blocked, a turn whose later reply got past the limit names the failure it ended on, and the API's own words for a request it refused
// keep no token its JSON repeats.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const CONTEXT_FULL="Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread.";
const LEAKED_TOKEN="tok-live-5f2c9a81e7d34b06";
const failedResult=(message,terminal_reason,extra={})=>({type:"result",subtype:"success",is_error:true,terminal_reason,result:"",user_message_uuid:message.uuid,total_cost_usd:0,usage:{input_tokens:3,output_tokens:0},...extra});

async function openThread(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}
async function send(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:5});await page.getByTestId("send").click()}

test("a Claude turn that fills its context says to compact, and a quick retry into a usage limit says when the limit resets",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const resetsAt=Math.floor(Date.now()/1000)+90*60;
  const harness=await startClaudeRelay({turn:async({message,index,emit})=>{
    // What Claude Code sends once the context is full: an invalid_request reply saying "Prompt is too long", then the result.
    if(index===0){
      emit({type:"assistant",uuid:"too-long",parent_tool_use_id:null,error:"invalid_request",message:{id:"m-too-long",content:[{type:"text",text:"Prompt is too long"}]}});
      emit(failedResult(message,"blocking_limit",{result:"Prompt is too long",num_turns:189}));return;
    }
    // The fourth turn's request is refused by an API whose error repeats a token in JSON.
    if(index===3){emit(failedResult(message,"api_error",{api_error_status:400,result:`API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Request rejected","request":{"token":"${LEAKED_TOKEN}"}}}`}));return}
    // No rate_limit_event: Claude Code throttles an unchanged one, and only the blocked reply repeats the rejected window.
    emit({type:"assistant",uuid:"blocked-"+index,parent_tool_use_id:null,error:"rate_limit",api_error_params:{rate_limit_info:{status:"rejected",rateLimitType:"five_hour",resetsAt}},message:{id:"m-blocked-"+index,content:[{type:"text",text:"API Error: Rate limited"}]}});
    // The third turn gets past the limit (a reply goes through), then fails for another reason.
    if(index===2){
      emit({type:"assistant",uuid:"through-"+index,parent_tool_use_id:null,message:{id:"m-through-"+index,content:[{type:"text",text:"Picking the summary up on the fallback model."}]}});
      emit(failedResult(message,"api_error",{result:"API Error"}));return;
    }
    emit(failedResult(message,"api_error",{api_error_status:429,result:"API Error: Rate limited"}));
  }});
  try{
    harness.seedThread("Repository summary",{permissionProfile:"supervised"});
    await routeClaudeApp(page,harness,{permissionMode:"supervised"});
    await page.goto("/");await openThread(page,"Repository summary");
    const errors=page.locator(".agent-block .tool-event.kind-error");

    await send(page,"Summarize every file in the repository");
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:15_000});
    // Soft, so that the old code also shows what the quick retry says.
    await expect.soft(errors.filter({hasText:CONTEXT_FULL}),"a full context says to compact").toBeVisible();
    await expect.soft(page.getByText("a usage limit blocked the request"),"a full context is not a usage limit").toHaveCount(0);
    await expect.soft(errors.filter({hasText:"Prompt is too long"}),"nor the reply's own words alone").toHaveCount(0);
    await page.screenshot({animations:"disabled",path:`${auditDir}claude-context-full-error-dark-1280x800.png`});

    await send(page,"Try again");
    const notice=page.getByText(/^Claude usage limit reached\. This turn is paused until the 5-hour limit resets in 1h (?:29|30)m\.$/);
    await expect(notice).toBeVisible({timeout:15_000});
    await expect(errors.filter({hasText:"Claude API rate limit reached. Try again later."})).toBeVisible();
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await notice.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-usage-limit-quick-retry-${mode}-1280x800.png`});
    }

    // A turn whose reply got past the limit, then failed for another reason, says that reason, not the limit's wait.
    await send(page,"Summarize the parser module");
    await expect(page.getByText("Picking the summary up on the fallback model.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:15_000});
    await expect.soft(errors.filter({hasText:"Claude gave up after repeated API errors."}),"the failure the turn ended on").toBeVisible();
    await expect.soft(errors.filter({hasText:"Send the message again once the 5-hour limit resets"}),"not the limit a later reply got past").toHaveCount(0);
    await page.getByText("Picking the summary up on the fallback model.",{exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:`${auditDir}claude-limit-then-reply-error-light-1280x800.png`});

    // The API's own words for a request it refused, without the token its JSON repeats.
    await send(page,"List the open issues");
    const refused=errors.filter({hasText:"API Error: 400"});
    await expect(refused).toBeVisible({timeout:15_000});
    await expect.soft(refused,"the token is not shown").toContainText('"request":{"token":"[redacted]"}');
    await expect.soft(page.getByText(LEAKED_TOKEN),"nowhere on the page").toHaveCount(0);
    await refused.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:`${auditDir}claude-api-error-token-redacted-light-1280x800.png`});
  }finally{await harness.close()}
});

// A turn that fails after Claude wrote part of its reply keeps that part under its failed pill, as a reply that completes stays, once
// the next message is sent and after a reload. While the turn's card is on screen the card says why it failed; once the card moves on
// to the next turn, and in the thread opened again, the reply says it under its pill, once.
test("a Claude turn that fails after Claude wrote part of its reply keeps that part, and says why it failed, after the next message and a reload",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const PARTIAL="Picking the summary up on the fallback model.",FAILED="Claude gave up after repeated API errors.";
  const harness=await startClaudeRelay({turn:async({message,index,emit})=>{
    // The first turn's reply goes through, then the turn fails on the API; the next one is answered.
    if(index===0){
      emit({type:"assistant",uuid:"partial",parent_tool_use_id:null,message:{id:"m-partial",content:[{type:"text",text:PARTIAL}]}});
      emit(failedResult(message,"api_error",{result:"API Error"}));return;
    }
    for(const frame of claudeReply(message,"All good now."))emit(frame);
  }});
  try{
    harness.seedThread("Parser summary",{permissionProfile:"supervised"});
    await routeClaudeApp(page,harness,{permissionMode:"supervised"});
    await page.goto("/");await openThread(page,"Parser summary");
    const conversation=page.locator(".conversation-column"),reply=page.locator(".history-assistant").filter({hasText:PARTIAL});
    const said=()=>conversation.getByText(FAILED).filter({visible:true});
    // The reply under the failed pill, which says why the turn failed: the only place on screen that says it, with no row of its own.
    const keptWithReason=async when=>{
      await expect(reply,"the reply is kept "+when).toHaveCount(1);
      await expect(reply.getByTestId("turn-outcome"),"under the failed pill "+when).toHaveText(/^failed/);
      await expect(reply.locator(".turn-outcome-message"),"which says why the turn failed "+when).toHaveText(FAILED);
      await expect(said(),"said once "+when).toHaveCount(1);
      await expect(page.getByTestId("turn-outcome-row"),"no row of its own "+when).toHaveCount(0);
    };

    await send(page,"Summarize the parser module");
    await expect(conversation.getByText(PARTIAL,{exact:true}).first()).toBeVisible({timeout:15_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:15_000});
    await expect(page.locator(".agent-block .tool-event.kind-error").filter({hasText:FAILED}),"the card says why the turn failed").toBeVisible();
    await expect(said(),"once, while the card is on screen").toHaveCount(1);

    await send(page,"Once more");
    await expect(page.getByText("All good now.",{exact:true})).toBeVisible({timeout:15_000});
    await keptWithReason("once the next message is sent");
    await reply.scrollIntoViewIfNeeded();
    await page.screenshot({animations:"disabled",path:`${auditDir}claude-failed-turn-reply-next-dark-1280x800.png`});

    await page.reload();await openThread(page,"Parser summary");
    await expect(page.getByText("All good now.",{exact:true})).toBeVisible({timeout:15_000});
    await keptWithReason("after a reload");
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await reply.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-failed-turn-reply-reloaded-${mode}-1280x800.png`});
    }
  }finally{await harness.close()}
});
