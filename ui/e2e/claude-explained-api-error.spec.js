import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { routeClaudeApp,startClaudeRelay } from "./claude-relay-harness.js";

// A Claude Code turn that ends on an API error its own reply explains (an unknown model, a bad request, a billing or account problem),
// as a person reads it on the real relay with Claude Code's SDK scripted: the turn's error is the reply's words, without the token
// and key they repeat, as the result's "API Error: …" text keeps none.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const TOKEN="tok-live-5f2c9a81e7d34b06",KEY="sk-ant-api03-Zx81fixturekey0042";
const WORDS=`There's an issue with the selected model (claude-gone-9). It may not exist or you may not have access to it. {"error":{"request":{"token":"${TOKEN}"}},"api_key":"${KEY}"}`;

async function openThread(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}
async function send(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:5});await page.getByTestId("send").click()}

test("a Claude API error its reply explains shows the reply's words without the token and key they repeat",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const harness=await startClaudeRelay({turn:async({message,emit})=>{
    emit({type:"assistant",uuid:"model-gone",parent_tool_use_id:null,error:"model_not_found",message:{id:"m-model-gone",content:[{type:"text",text:WORDS}]}});
    emit({type:"result",subtype:"success",is_error:true,terminal_reason:"api_error",api_error_status:404,result:WORDS,user_message_uuid:message.uuid,total_cost_usd:0,usage:{input_tokens:3,output_tokens:0}});
  }});
  try{
    harness.seedThread("Parser summary",{permissionProfile:"supervised"});
    await routeClaudeApp(page,harness,{permissionMode:"supervised"});
    await page.goto("/");await openThread(page,"Parser summary");
    await send(page,"Summarize the parser");
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:15_000});
    const error=page.locator(".agent-block .tool-event.kind-error").filter({hasText:"There's an issue with the selected model (claude-gone-9)."});
    await expect(error).toBeVisible({timeout:15_000});
    await expect.soft(error,"the token is not shown").toContainText('"request":{"token":"[redacted]"}');
    await expect.soft(page.getByText(TOKEN),"nor anywhere on the page").toHaveCount(0);
    await expect.soft(page.getByText(KEY.slice(0,14)),"nor the key").toHaveCount(0);
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await error.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-explained-api-error-redacted-${mode}-1280x800.png`});
    }
  }finally{await harness.close()}
});
