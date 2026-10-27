import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { claudeReply,routeClaudeApp,startClaudeRelay } from "./claude-relay-harness.js";

// Stop pressed while Claude Code still connects the thread's MCP servers ends the message before Claude Code gets it, so no transcript
// holds it, on the real relay with Claude Code's SDK scripted. The person sends the message again and then edits that one from here:
// the edit goes on in a conversation of its own, instead of Claude Code being asked to resume at the stopped message, which it never
// wrote, so that the edit was undone (the conversation put back as it was, the thread left running).
const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});

async function openThread(page,title){
  const row=page.locator(".thread-row").filter({has:page.locator(`.thread-main[title="${title}"]`)});
  await expect(row).toBeVisible({timeout:15_000});await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
}
async function send(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:5});await page.getByTestId("send").click()}

test("Edit from here on a message sent again after Stop while Claude Code connected the thread's MCP servers goes on, the stopped message being in no transcript",async({page})=>{
  test.setTimeout(90_000);
  await page.setViewportSize({width:1280,height:800});
  // What Claude Code wrote to its transcript: the messages it took in and its replies.
  const written=new Set();let replies=0;
  const harness=await startClaudeRelay({
    mcpServers:[{name:"Workspace tools",runtime:"claude",command:"workspace-mcp",args:["--stdio"],enabled:true}],
    turn:async({message,emit})=>{
      written.add(message.uuid);
      for(const frame of claudeReply(message,++replies===1?"Ran the tests: all green.":"Ran the tests and the linter: all green.")){if(frame.uuid)written.add(frame.uuid);emit(frame)}
    },
    control:{
      // The first Claude Code never finishes connecting the servers; the later ones connect at once.
      setMcpServers:(servers,{index})=>index===0?new Promise(()=>{}):{added:Object.keys(servers),removed:[],errors:{}},
      // A Claude Code asked to fork at a message its transcript does not have exits before it starts the session.
      open:options=>options.resumeSessionAt&&!written.has(options.resumeSessionAt)?new Error(`Claude Code process exited with code 1. stderr: No message found with message.uuid of: ${options.resumeSessionAt}`):null,
    },
  });
  try{
    harness.seedThread("Checks",{permissionProfile:"edits"});
    await routeClaudeApp(page,harness,{permissionMode:"edits"});
    await page.goto("/");await openThread(page,"Checks");
    const stop=page.getByRole("button",{name:"Stop",exact:true}),composer=page.getByTestId("composer");

    // Stop while Claude Code connects the servers: the message never reaches it.
    await send(page,"Run the linter");
    await expect(stop).toBeVisible({timeout:15_000});
    await stop.click();
    await expect(page.getByTestId("turn-outcome").last()).toHaveText(/^stopped/,{timeout:15_000});

    // Sent again, the next message goes through.
    await send(page,"Run the tests");
    await expect(page.getByText("Ran the tests: all green.",{exact:true})).toBeVisible({timeout:15_000});
    await expect(stop).toHaveCount(0,{timeout:15_000});

    // Edit from here on it, as the person edits it: the edited message gets its reply.
    const bubble=page.locator(".user-bubble").filter({hasText:"Run the tests"});
    await bubble.getByRole("button",{name:"Edit from here",exact:true}).click();
    await page.getByRole("dialog").getByRole("button",{name:"Edit from here",exact:true}).click();
    await expect(composer).toHaveValue("Run the tests",{timeout:15_000});
    // The composer takes the keyboard once the thread is read again, its caret at the message's end.
    await expect(composer).toBeFocused({timeout:15_000});
    await composer.press("End");await page.keyboard.type(" and the linter",{delay:5});
    await expect(composer).toHaveValue("Run the tests and the linter");
    await page.getByTestId("send").click();
    await expect.soft(page.getByText("Ran the tests and the linter: all green.",{exact:true}),"the edited message gets its reply").toBeVisible({timeout:15_000});
    await expect.soft(page.locator(".user-bubble").filter({hasText:"Run the tests and the linter"}),"the edited message stands").toHaveCount(1);
    await expect(stop,"and the thread is not left running").toHaveCount(0,{timeout:15_000});
    for(const mode of ["dark","light"]){
      if(mode==="light"){await page.locator("[data-testid=appearance-toggle]:visible").first().click();await expect(page.locator("html")).toHaveAttribute("data-mode","light")}
      await page.screenshot({animations:"disabled",path:`${auditDir}claude-stop-while-connecting-edit-${mode}-1280x800.png`});
    }
  }finally{await harness.close()}
});
