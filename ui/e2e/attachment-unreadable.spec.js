import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { replyItem,routeRelayApp,startRelayHarness } from "./relay-history-harness.js";

// An attachment whose saved file is gone by the time its message goes is named, with what to do, in plain words with no system code.
// The composer's check before a send takes the chip of every file that is gone off the draft and says so once beside the composer,
// keeping the draft, so the next send goes (L10-F-1, 2026-11-02: the dead chip refused every later send, after a restart and on
// another provider too, with only the first refusal's card to show for it); the relay says so and keeps the draft for an
// image that went after that check, before the message's turn exists, so no turn is left running and the thread takes the next
// message. Either says so after the conversation's last reply, as the message's own, never as a step of the turn before it: also
// the queue's refusal of a follow-up whose image went while it waited. A Trebell Native thread on the real agent relay, with its
// provider scripted (relay-history-harness.js).
const auditDir=fileURLToPath(new URL("../../visual-audit/attachment-unreadable/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
const PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==","base64");

async function openThread(page,replies=[]){
  const harness=await startRelayHarness({replies});
  harness.seedThread("Attachments thread",[{user:"Look at the login page",items:[replyItem("seed-reply-1","The login page renders.")]}]);
  await routeRelayApp(page,harness);
  // The theme button's setting stays in the page, so later specs on the shared server keep theirs.
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Attachments thread"]')});
  await row.locator(".thread-main").click();
  await expect(row).toHaveClass(/active/);await expect(page.getByTestId("composer")).not.toHaveAttribute("placeholder","Opening thread…");
  return harness;
}
// The file picked through Attach files, uploaded and taken in as the composer does it; the answer that takes it in names where it was
// saved. The shelf names the file while it uploads too, so the chip is waited for once the file is in.
async function attach(page,file){
  const imported=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/attachments/import");
  const [chooser]=await Promise.all([page.waitForEvent("filechooser"),page.getByRole("button",{name:"Attach files"}).click()]);
  await chooser.setFiles(file);
  const {files}=await (await imported).json();
  await expect(page.getByRole("button",{name:"Remove "+file.name})).toBeVisible();
  return files[0].path;
}
async function type(page,text){await page.getByTestId("composer").click();await page.keyboard.type(text,{delay:5})}
// Where a row reads on screen, top to bottom.
const edges=locator=>locator.evaluate(node=>{const box=node.getBoundingClientRect();return {top:Math.round(box.top),bottom:Math.round(box.bottom)}});
// The activity card a step is listed in.
const cardOf=step=>step.locator("xpath=ancestor::*[@data-testid='activity-card'][1]");
async function readsBelow(row,reply){const [{top},{bottom}]=await Promise.all([edges(cardOf(row)),edges(reply)]);expect(top,"the refusal's card reads below the reply").toBeGreaterThanOrEqual(bottom)}
// Dark and light at 1280x800 and 900x800, switched with the header's toggle as a person switches them.
async function shots(page,name,check=async()=>{}){
  for(const mode of ["dark","light"]){
    if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").first().click();
    await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await check();await page.screenshot({animations:"disabled",path:`${auditDir}${name}-${mode}-${width}x800.png`})}
  }
  await page.setViewportSize({width:1280,height:800});
  if(await page.locator("html").getAttribute("data-mode")!=="dark")await page.getByTestId("appearance-toggle").first().click();
}

test("a send whose attached file is gone takes its chip off, says so once beside the composer and keeps the draft, and the next send goes",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openThread(page,[{text:"The notes did not come with it."}]);
  try{
    const saved=await attach(page,{name:"notes.txt",mimeType:"text/plain",buffer:Buffer.from("release notes\n")});
    await attach(page,{name:"plan.txt",mimeType:"text/plain",buffer:Buffer.from("the plan\n")});
    // The saved copy goes before the message is sent, as a cleanup of the attachments folder would take it.
    await rm(saved,{force:true});
    await type(page,"Summarize the notes");await page.getByTestId("send").click();
    const said=page.getByTestId("composer-alert");
    await expect(said).toHaveText('"notes.txt" is no longer on this computer, so it was taken off your message. Attach it again, or send the message without it.');
    await expect(said).toHaveAttribute("role","alert");
    await expect(page.getByText(/ENOENT|no such file or directory/)).toHaveCount(0);
    await expect(page.locator(".tool-event"),"no card stands for the refusal").toHaveCount(0);
    await expect(page.getByTestId("composer")).toHaveValue("Summarize the notes");
    await expect(page.getByRole("button",{name:"Remove notes.txt"}),"the chip of the file that is gone is off the draft").toHaveCount(0);
    await expect(page.getByRole("button",{name:"Remove plan.txt"}),"the other file stays").toBeVisible();
    expect(harness.providerCalls(),"nothing went to the provider").toBe(0);
    await shots(page,"send-attachment-gone",()=>expect(said).toBeVisible());
    // At a phone's width too, where the header's toggle is folded away: the mode is switched at 1280 first.
    await expect(page.locator("html")).toHaveAttribute("data-mode","dark");
    for(const mode of ["dark","light"]){
      if(await page.locator("html").getAttribute("data-mode")!==mode)await page.getByTestId("appearance-toggle").first().click();
      await expect(page.locator("html")).toHaveAttribute("data-mode",mode);
      await page.setViewportSize({width:390,height:800});await expect(said).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),"no sideways scroll at 390").toBe(true);
      await page.screenshot({animations:"disabled",path:`${auditDir}send-attachment-gone-${mode}-390x800.png`});
      await page.setViewportSize({width:1280,height:800});
    }
    if(await page.locator("html").getAttribute("data-mode")!=="dark")await page.getByTestId("appearance-toggle").first().click();
    // The next press sends the message, with the file that is still there.
    await page.getByTestId("send").click();
    await expect(page.getByText("The notes did not come with it.",{exact:true})).toBeVisible({timeout:20_000});
    expect(harness.providerCalls(),"the message went").toBe(1);
    await expect(said).toHaveCount(0);
    await expect(page.locator(".user-bubble").last()).toContainText("plan.txt");
    await expect(page.locator(".user-bubble").last()).not.toContainText("notes.txt");
  }finally{await harness.close()}
});

test("every attached file that is gone comes off the draft with one refusal that names them all",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openThread(page);
  try{
    const first=await attach(page,{name:"number-png.png",mimeType:"image/png",buffer:PNG});
    const second=await attach(page,{name:"notes.txt",mimeType:"text/plain",buffer:Buffer.from("release notes\n")});
    await rm(first,{force:true});await rm(second,{force:true});
    await type(page,"What is in these?");await page.getByTestId("send").click();
    await expect(page.getByTestId("composer-alert")).toHaveText('"number-png.png" and "notes.txt" are no longer on this computer, so they were taken off your message. Attach them again, or send the message without them.');
    await expect(page.locator(".attachment-shelf > span")).toHaveCount(0);
    await expect(page.getByTestId("composer")).toHaveValue("What is in these?");
    expect(harness.providerCalls()).toBe(0);
    await shots(page,"send-attachments-gone",()=>expect(page.getByTestId("composer-alert")).toBeVisible());
  }finally{await harness.close()}
});

test("a send whose attached image went after the composer's check is not sent, says which one, keeps the draft and leaves no turn running",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openThread(page,[{text:"No image this time, then."}]);
  try{
    const saved=await attach(page,{name:"shot.png",mimeType:"image/png",buffer:PNG});
    // The composer's check finds the image, which goes before the relay reads it.
    await page.route(/\/api\/attachments\/validate$/,async route=>{await rm(saved,{force:true});return json(route,{files:[],count:1,imageBytes:PNG.length})});
    await type(page,"What is in this screenshot?");await page.getByTestId("send").click();
    const said=page.getByTestId("composer-alert");
    await expect(said).toHaveText('Not sent: The attached image "shot.png" is no longer on this computer. Attach it again. Your draft is kept.',{timeout:20_000});
    await expect(page.getByText(/ENOENT|no such file or directory/)).toHaveCount(0);
    await expect(page.getByTestId("composer")).toHaveValue("What is in this screenshot?");
    await expect(page.getByRole("button",{name:"Remove shot.png"})).toBeVisible();
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toHaveCount(0);
    expect(harness.providerCalls(),"nothing went to the provider").toBe(0);
    expect(harness.turns(harness.threads[0]).map(turn=>turn.status),"no turn was left running").toEqual(["completed"]);
    await shots(page,"send-image-gone",()=>expect(said).toBeVisible());
    // The person takes the image off and sends on: the thread takes the message.
    await page.unroute(/\/api\/attachments\/validate$/);
    await page.getByRole("button",{name:"Remove shot.png"}).click();await expect(page.getByRole("button",{name:"Remove shot.png"})).toHaveCount(0);
    await page.getByTestId("composer").click();await page.keyboard.press("Control+A");await page.keyboard.type("Never mind.",{delay:5});await page.getByTestId("send").click();
    await expect(page.getByText("No image this time, then.",{exact:true})).toBeVisible({timeout:20_000});
    expect(harness.turns(harness.threads[0]).map(turn=>turn.status)).toEqual(["completed","completed"]);
  }finally{await harness.close()}
});

test("a send its own file check refuses says so below the conversation's last reply, and the turn before it stays as it was",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openThread(page);
  try{
    await attach(page,{name:"notes.txt",mimeType:"text/plain",buffer:Buffer.from("release notes\n")});
    // A refusal of the check that is no file gone (one a file that is gone gets is said beside the composer, above): the message's
    // images over their limit together.
    await page.route(/\/api\/attachments\/validate$/,route=>route.fulfill({status:400,contentType:"application/json",body:JSON.stringify({error:"Images in one message cannot exceed 80 MiB total"})}));
    const answer=page.locator(".history-assistant").filter({hasText:"The login page renders."});
    await expect(answer).toBeVisible();const before=await edges(answer);
    // Sent with the Send button, then again with Enter: each refusal reads after the earlier turn's reply, which stays where it was.
    await type(page,"Summarize the notes");await page.getByTestId("send").click();
    const said=page.locator(".tool-event").filter({hasText:"Images in one message cannot exceed 80 MiB total"});
    await expect(said).toHaveCount(1);
    expect(await edges(answer),"the earlier reply has not moved").toEqual(before);
    await readsBelow(said.first(),answer);
    await page.getByTestId("composer").press("Enter");
    await expect(said).toHaveCount(2);
    expect(await edges(answer),"the earlier reply has not moved").toEqual(before);
    await readsBelow(said.last(),answer);
    await expect(page.getByTestId("composer")).toHaveValue("Summarize the notes");
    expect(harness.providerCalls(),"nothing went to the provider").toBe(0);
    await shots(page,"send-attachment-gone-below-reply",()=>readsBelow(said.first(),answer));
    // The refusal was this window's alone: once the window is reloaded, the earlier turn reads as it did, with nothing failed.
    await page.reload();
    const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Attachments thread"]')});
    await row.locator(".thread-main").click();await expect(row).toHaveClass(/active/);
    await expect(answer).toBeVisible();await expect(said).toHaveCount(0);await expect(page.locator(".activity-card-failed")).toHaveCount(0);
  }finally{await harness.close()}
});

test("a follow-up the queue cannot start because its image is gone says so below the reply it followed, not as a step of that turn",async({page})=>{
  test.setTimeout(90_000);
  let release=()=>{};const held=new Promise(resolve=>{release=resolve});
  const harness=await openThread(page,[async()=>{await held;return {text:"The login form has two fields."}}]);
  try{
    await type(page,"Describe the login form");await page.keyboard.press("Enter");
    await expect(page.getByRole("button",{name:"Stop",exact:true})).toBeVisible({timeout:20_000});
    // While the reply is on its way, the person queues a follow-up with a screenshot, whose saved copy goes before the queue starts it.
    const saved=await attach(page,{name:"shot.png",mimeType:"image/png",buffer:PNG});
    await type(page,"And this screenshot?");await page.keyboard.press("Enter");
    const queued=page.locator(".queued-message").filter({hasText:"And this screenshot?"});
    await expect(queued).toBeVisible();
    await rm(saved,{force:true});release();
    const answer=page.locator(".history-assistant").filter({hasText:"The login form has two fields."});
    await expect(answer).toBeVisible({timeout:20_000});
    const said=page.locator(".tool-event").filter({hasText:'Could not start queued Native follow-up: The attached image "shot.png" is no longer on this computer. Attach it again.'});
    await expect(said).toHaveCount(1,{timeout:20_000});
    // The turn's card lists its own step only, nothing failed, and the refusal reads below that turn's reply.
    const card=page.locator("[data-testid=activity-card]").filter({hasText:"Trebell context skipped"});
    await expect(card).toHaveCount(1);
    await expect(card,"the turn's card does not list the refusal").not.toContainText("Could not start queued");
    await expect(card.locator(".activity-card-failed")).toHaveCount(0);
    await readsBelow(said,answer);
    await expect(queued).toBeVisible();
    expect(harness.providerCalls(),"the follow-up did not reach the provider").toBe(1);
    await shots(page,"queued-image-gone-below-reply",()=>readsBelow(said,answer));
  }finally{release();await harness.close()}
});
