import { test,expect } from "@playwright/test";
import { mkdirSync,readFileSync } from "node:fs";
import { readFile,rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { routeCodexApp,startCodexHarness } from "./codex-history-harness.js";

// A send checks a message's files twice, as the composer sends it and again as its turn starts, right after. Only the first check
// extracts an attached document's text, as T3 Code claims a message's attachments once, and the second only finds that text: a message
// whose documents have no text yet (attached while Trebell Native was the harness, or whose text could not be read then) runs each
// one's extraction once before its turn starts, not twice, and Codex's message still names the text of each. The mock GUI server
// uploads, checks and extracts for real; Codex is a stand-in.
const auditDir=fileURLToPath(new URL("../../visual-audit/document-send-check/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const fixture=name=>readFileSync(fileURLToPath(new URL("../../tests/fixtures/documents/"+name,import.meta.url)));
const DOCX="application/vnd.openxmlformats-officedocument.wordprocessingml.document",PPTX="application/vnd.openxmlformats-officedocument.presentationml.presentation";
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
// The lines Codex's message names the attached documents by, with each one's saved path and the file its text was extracted to.
const LINES={
  report:/\[Attached file "report\.docx" is saved at: ([^\n]+?report\.docx) \(text extracted to: ([^\n]+?report\.docx\.txt)\)\]/,
  deck:/\[Attached file "deck\.pptx" is saved at: ([^\n]+?deck\.pptx) \(text extracted to: ([^\n]+?deck\.pptx\.txt)\)\]/,
};
const TEXTS={report:/^# Quarterly Harbor Report\nCargo volume rose 12 percent/,deck:/^## Slide 1\n\nDeparture plan\nFerries leave at 06:40/};

test("a message with two documents whose text is not there yet extracts each one's text once as it goes, in the first of its two checks, and Codex's message names that text",async({page})=>{
  test.setTimeout(90_000);
  const thread={id:"codex-documents",name:"Harbor papers",preview:"Harbor papers",cwd:process.cwd(),status:{type:"idle"},model:"test/coding-fast",createdAt:Date.now()/1000-60,updatedAt:Date.now()/1000,turns:[]};
  const harness=await startCodexHarness(thread,[(turn,{emit,threadId,finish})=>{
    emit({method:"turn/started",params:{threadId,turn:{...turn,items:[]}}});
    const answer={id:"agent-"+turn.id,type:"agentMessage",text:"The report and the deck agree on the ferry times."};turn.items.push(answer);emit({method:"item/completed",params:{threadId,turnId:turn.id,item:answer}});finish("completed");
  }]);
  try{
    await routeCodexApp(page,harness,thread);
    await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
    // What each check of the message's files asks of the server, as the composer sends it; and what taking the files in answered.
    const checks=[],taken=[];
    await page.route(/\/api\/attachments\/validate$/,route=>{checks.push(route.request().postDataJSON());return route.fallback()});
    page.on("response",response=>{if(/\/api\/attachments\/import$/.test(response.url()))taken.push(response.json().catch(()=>null))});
    await page.setViewportSize({width:1280,height:800});
    await page.goto("/");
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Harbor papers"]')}),composer=page.getByTestId("composer");
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);await expect(composer).not.toHaveAttribute("placeholder","Opening thread…");
    const [chooser]=await Promise.all([page.waitForEvent("filechooser"),page.getByRole("button",{name:"Attach files",exact:true}).click()]);
    await chooser.setFiles([{name:"report.docx",mimeType:DOCX,buffer:fixture("report.docx")},{name:"deck.pptx",mimeType:PPTX,buffer:fixture("deck.pptx")}]);
    await expect(page.getByRole("button",{name:"Remove report.docx"})).toBeVisible({timeout:20_000});
    await expect(page.getByRole("button",{name:"Remove deck.pptx"})).toBeVisible({timeout:20_000});
    // Taking them in on this machine extracted their text; it is gone as the message goes, as for documents attached while Trebell
    // Native was the harness, which extracts none.
    await expect.poll(async()=>(await Promise.all(taken)).flatMap(answer=>answer?.files||[]).filter(file=>file.textPath).length,{message:"the files taken in"}).toBe(2);
    for(const file of (await Promise.all(taken)).flatMap(answer=>answer?.files||[]))await rm(file.textPath,{force:true});
    checks.length=0;
    await composer.click();await page.keyboard.type("Compare the report with the deck",{delay:5});await page.keyboard.press("Enter");
    await expect(page.getByText("The report and the deck agree on the ferry times.",{exact:true})).toBeVisible({timeout:20_000});
    // The send checked its files twice; only the first check may extract their text, and the second only finds it.
    expect(checks.map(body=>({files:body.paths?.length??0,extracts:body.extract!==false})),"the send's checks of its files").toEqual([{files:2,extracts:true},{files:2,extracts:false}]);
    const sent=harness.turns.at(-1).items[0].content[0].text;
    for(const [name,line] of Object.entries(LINES)){
      expect(sent,`Codex is told where the ${name}'s text is`).toMatch(line);
      const [,saved,textPath]=line.exec(sent);expect(textPath).toBe(saved+".txt");
      expect(await readFile(textPath,"utf8"),`the ${name}'s text, extracted as the message went`).toMatch(TEXTS[name]);
    }
    const bubble=page.locator(".user-bubble").filter({hasText:"Compare the report with the deck"}),files=bubble.locator(".user-attachments > span");
    await expect(files).toHaveText(["report.docx","deck.pptx"]);
    for(const mode of ["dark","light"]){
      if(await page.locator("html").getAttribute("data-mode")!==mode)await page.locator("[data-testid=appearance-toggle]:visible").first().click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);await expect(files.first()).toBeInViewport();
      await page.screenshot({animations:"disabled",path:`${auditDir}codex-message-documents-extracted-once-${mode}-1280x800.png`});
    }
  }finally{await harness.close()}
});
