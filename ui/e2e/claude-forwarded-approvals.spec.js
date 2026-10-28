import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { claudeReply,routeClaudeApp,startClaudeRelay } from "./claude-relay-harness.js";

// Claude Code in Full access still asks about what it never approves itself (an ask rule, its own safety checks). Those requests
// reach the person with Claude's own reason, on the real relay with Claude Code's SDK scripted, and nothing runs until they answer.
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const GIT_PUSH_RULE={source:"userSettings",toolName:"Bash",ruleContent:"git push:*"};

// The thread is open once its open is done, as a person sees it open: a mode picked in the open's first moment, before its cover holds
// the pickers, would race the thread's own mode as the open lands.
async function openThread(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
  await expect(page.getByTestId("composer")).not.toHaveAttribute("placeholder","Opening thread…");
}
async function send(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:5});await page.getByTestId("send").click()}

test("Claude Code's requests in Full access reach the person with Claude's reason and run only once they allow them",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const decisions=[];
  const harness=await startClaudeRelay({turn:async({message,index,options,emit,signal})=>{
    // The first prompt runs a push the person's ask rule holds back; the second an rm Claude Code's own safety check holds back.
    const [command,title,extra,done,kept]=index===0
      ?["git push origin main","Claude wants to run git push origin main",{matchedAskRule:GIT_PUSH_RULE},"Pushed main to origin.","Left main unpushed."]
      :['rm -r -- "$rr/$h"','Claude wants to run rm -r -- "$rr/$h"',{decisionReason:"\u001b[33mDangerous rm on a path built from a variable\u001b[39m",suppressAlwaysAllowRule:true,defaultToNo:true},"Removed the old build folders.","Kept the old build folders."];
    const decision=await options.canUseTool("Bash",{command},{toolUseID:"tool-"+index,signal,title,suggestions:[],...extra});
    decisions.push(decision.behavior);
    for(const frame of claudeReply(message,decision.behavior==="allow"?done:kept))emit(frame);
  }});
  try{
    harness.seedThread("Release push");
    await routeClaudeApp(page,harness,{permissionMode:"full"});
    await page.goto("/");await openThread(page,"Release push");
    await expect(page.locator("select.permission-picker:not(.collaboration-mode-picker)")).toHaveValue("full");
    const card=page.locator(".inline-approval .approval-card");

    await send(page,"Push the release to origin");
    await expect(card).toBeVisible({timeout:15_000});
    await expect(card.locator(".card-title strong")).toHaveText("Command needs approval");
    await expect(card.locator("p:not(.approval-thread)")).toHaveText("Claude Code asks even in Full access, as its ask rule Bash(git push:*) says: Claude wants to run git push origin main");
    await expect(card.getByRole("button")).toHaveText(["Deny","Allow session","Allow once"]);
    await expect(page.getByText("Pushed main to origin.",{exact:true})).toHaveCount(0);expect(decisions,"nothing ran before the person answered").toEqual([]);
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-full-access-ask-rule-card-${mode}-1280x800.png`});
    }
    await card.getByRole("button",{name:"Allow once",exact:true}).click();
    await expect(page.getByText("Pushed main to origin.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(card).toHaveCount(0);expect(decisions).toEqual(["allow"]);

    await send(page,"Clear the old build folders");
    await expect(card).toBeVisible({timeout:15_000});
    // Claude's own reason, without the terminal colours it came with, and no session choice: Claude Code wants it decided once.
    await expect(card.locator("p:not(.approval-thread)")).toHaveText('Claude Code asks even in Full access: Claude wants to run rm -r -- "$rr/$h" (Dangerous rm on a path built from a variable)');
    await expect(card.getByRole("button")).toHaveText(["Deny","Allow once"]);
    await page.screenshot({animations:"disabled",path:`${auditDir}claude-full-access-safety-check-card-light-1280x800.png`});
    await card.getByRole("button",{name:"Deny",exact:true}).click();
    await expect(page.getByText("Kept the old build folders.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(card).toHaveCount(0);expect(decisions).toEqual(["allow","deny"]);
  }finally{await harness.close()}
});

// In Plan mode Claude Code asks before what Plan mode holds back, whatever the profile: a Full access thread's card says Plan mode
// asks, not that Claude Code overruled Full access.
test("a Claude Code request in Plan mode says Plan mode asks, also in a Full access thread",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const asked=[];
  const harness=await startClaudeRelay({turn:async({message,options,emit,signal})=>{
    asked.push(options.permissionMode);
    const decision=await options.canUseTool("Edit",{file_path:harness.repo+"/src/helper.js",old_string:"oldName",new_string:"newName"},{toolUseID:"edit-plan",signal,suggestions:[]});
    for(const frame of claudeReply(message,decision.behavior==="allow"?"Renamed the helper.":"Left the helper as it was."))emit(frame);
  }});
  try{
    harness.seedThread("Helper rename");
    await routeClaudeApp(page,harness,{permissionMode:"full"});
    await page.goto("/");await openThread(page,"Helper rename");
    await expect(page.locator("select.permission-picker:not(.collaboration-mode-picker)")).toHaveValue("full");
    await page.getByTestId("collaboration-mode-picker").selectOption("plan");
    await expect(page.getByTestId("collaboration-mode-picker")).toHaveValue("plan");
    const card=page.locator(".inline-approval .approval-card");

    await send(page,"Rename the old helper");
    await expect(card).toBeVisible({timeout:15_000});
    expect(asked,"Claude Code runs in Plan mode").toEqual(["plan"]);
    await expect(card.locator("p:not(.approval-thread)")).toHaveText(`Claude Code asks in Plan mode: Edit: ${harness.repo}/src/helper.js`);
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-plan-mode-ask-card-${mode}-1280x800.png`});
    }
    await card.getByRole("button",{name:"Deny",exact:true}).click();
    await expect(page.getByText("Left the helper as it was.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(card).toHaveCount(0);
  }finally{await harness.close()}
});

// An administrator can turn Claude Code's bypass off (disableBypassPermissionsMode): Claude Code then opens a Full access thread in
// Supervised mode, says so as it starts, and asks for what that mode holds back. The card names the mode Claude Code runs in.
test("a Claude Code request in a Full access thread whose Claude Code runs in Supervised mode says so, not that it asks even in Full access",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  const asked=[];
  const harness=await startClaudeRelay({
    turn:async({message,options,emit,signal})=>{
      asked.push(options.permissionMode);
      const decision=await options.canUseTool("Edit",{file_path:harness.repo+"/src/config.js",old_string:"debug: true",new_string:"debug: false"},{toolUseID:"edit-supervised",signal,suggestions:[]});
      for(const frame of claudeReply(message,decision.behavior==="allow"?"Turned debug off.":"Left debug on."))emit(frame);
    },
    control:{init:()=>({permissionMode:"default"})},
  });
  try{
    harness.seedThread("Config cleanup");
    await routeClaudeApp(page,harness,{permissionMode:"full"});
    await page.goto("/");await openThread(page,"Config cleanup");
    await expect(page.locator("select.permission-picker:not(.collaboration-mode-picker)")).toHaveValue("full");
    const card=page.locator(".inline-approval .approval-card");

    await send(page,"Turn debug off in the config");
    await expect(card).toBeVisible({timeout:15_000});
    expect(asked,"Full access was asked for").toEqual(["bypassPermissions"]);
    await expect(card.locator("p:not(.approval-thread)")).toHaveText(`Claude Code asks, as it runs in Supervised mode, not Full access: Edit: ${harness.repo}/src/config.js`);
    await expect(page.getByText("Turned debug off.",{exact:true})).toHaveCount(0);
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-full-access-runs-supervised-card-${mode}-1280x800.png`});
    }
    await card.getByRole("button",{name:"Allow once",exact:true}).click();
    await expect(page.getByText("Turned debug off.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(card).toHaveCount(0);
  }finally{await harness.close()}
});
