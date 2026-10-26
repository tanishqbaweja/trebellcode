import { test,expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { claudeReply,routeClaudeApp,startClaudeRelay } from "./claude-relay-harness.js";

// Typing into a running Claude Code turn no longer ends the subagent it waits on: the subagent moves to the background before the
// steer reaches the turn, and its result comes in later, in a turn of its own. On the real relay, with Claude Code's SDK scripted.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const FOUND="The reviewer found two problems in src/parser.js: a missing bounds check in readToken and an unclosed string at line 88.";

async function openThread(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}
async function type(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:5})}

test("a steer into a Claude Code turn keeps the subagent it waits on, whose findings come in later in a turn of their own",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  let first=null,moved=false;
  const harness=await startClaudeRelay({
    // Claude Code answers a subagent it moved to the background at once, so the turn no longer waits on it.
    control:{backgroundTasks:(toolUseId,{emit})=>{
      if(toolUseId!=="toolu_review")return false;moved=true;
      emit({type:"user",parent_tool_use_id:null,message:{role:"user",content:[{type:"tool_result",tool_use_id:"toolu_review",content:"The reviewer now runs in the background. You will be told when it finishes."}]}});
      return true;
    }},
    turn:async({message,index,emit})=>{
      if(index===0){
        first=message;
        emit({type:"assistant",uuid:randomUUID(),parent_tool_use_id:null,message:{id:"msg-launch",content:[{type:"text",text:"Starting a reviewer on the parser."},{type:"tool_use",id:"toolu_review",name:"Agent",input:{description:"Review the parser",prompt:"Review src/parser.js for bugs",subagent_type:"code-reviewer"}}]}});
        return;
      }
      // The steer cancels the turn's running tool calls: a subagent still in the foreground ends with them, its work lost.
      if(!moved)emit({type:"user",parent_tool_use_id:null,message:{role:"user",content:[{type:"tool_result",tool_use_id:"toolu_review",is_error:true,content:"[Request interrupted by user for tool use]"}]}});
      emit({type:"result",subtype:"error_during_execution",is_error:true,terminal_reason:"aborted_tools",errors:[],user_message_uuid:first.uuid,total_cost_usd:0,usage:{input_tokens:3,output_tokens:1}});
      for(const frame of claudeReply(message,moved?"Switched the new code to tabs. The reviewer keeps going in the background.":"Switched the new code to tabs."))emit(frame);
      // A subagent in the background tells Claude Code when it finishes, and Claude answers in a turn of its own.
      if(moved)setTimeout(()=>{
        emit({type:"assistant",uuid:randomUUID(),parent_tool_use_id:null,message:{id:"msg-found",content:[{type:"text",text:FOUND}]}});
        emit({type:"result",subtype:"success",is_error:false,result:FOUND,origin:{kind:"task-notification"},total_cost_usd:0,usage:{input_tokens:3,output_tokens:1}});
      },600);
    },
  });
  try{
    harness.seedThread("Parser review");
    await routeClaudeApp(page,harness,{permissionMode:"full",followUpMode:"steer"});
    await page.goto("/");await openThread(page,"Parser review");
    const agent=page.locator("details.tool-event").filter({has:page.locator("strong",{hasText:/^Agent$/})});

    await type(page,"Review the parser and fix what it finds");await page.getByTestId("send").click();
    await expect(page.getByText("Starting a reviewer on the parser.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(agent.locator("em")).toHaveText("running");
    await type(page,"Use tabs, not spaces, in the new code");
    await page.getByRole("button",{name:"Steer agent",exact:true}).click();
    await expect(page.getByText(/^Switched the new code to tabs\./)).toBeVisible({timeout:15_000});
    await expect(page.getByText("Use tabs, not spaces, in the new code",{exact:true})).toBeVisible();
    // What the reviewer found comes in later, on its own, and the steered turn's card lists the reviewer as done, not cut off.
    const found=page.getByText(FOUND,{exact:true});
    await expect(found).toBeVisible({timeout:15_000});
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0,{timeout:15_000});
    const card=page.getByTestId("activity-card").first();
    await expect(card).toHaveAttribute("data-state","closed");await expect(card.locator(".activity-card-failed")).toHaveCount(0);
    await card.locator(".activity-card-head").click();await expect(card).toHaveAttribute("data-state","open");
    await expect(agent).toBeVisible();await expect(agent).not.toHaveClass(/status-error/);await expect(agent.locator("em")).toHaveText("done");
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await found.scrollIntoViewIfNeeded();
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-steer-keeps-subagent-${mode}-1280x800.png`});
    }
  }finally{await harness.close()}
});
