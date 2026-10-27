import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { replyItem,routeRelayApp,startRelayHarness } from "./relay-history-harness.js";

// An attachment whose saved file is gone by the time its message goes is named, with what to do, instead of Node's bare ENOENT (T3
// says "an attachment could not be read"). The composer's check before a send says so and keeps the draft; so does the relay for an
// image that went after that check, before the message's turn exists, so no turn is left running and the thread takes the next
// message. A Trebell Native thread on the real agent relay, with its provider scripted (relay-history-harness.js).
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

test("a send whose attached file is gone says which one and to attach it again, keeps the draft and sends nothing",async({page})=>{
  test.setTimeout(90_000);
  const harness=await openThread(page);
  try{
    const saved=await attach(page,{name:"notes.txt",mimeType:"text/plain",buffer:Buffer.from("release notes\n")});
    // The saved copy goes before the message is sent, as a cleanup of the attachments folder would take it.
    await rm(saved,{force:true});
    await type(page,"Summarize the notes");await page.getByTestId("send").click();
    const said=page.getByText('The attached file "notes.txt" could not be read (ENOENT). Attach it again.').first();
    await expect(said).toBeVisible();
    await expect(page.getByText(/no such file or directory/)).toHaveCount(0);
    await expect(page.getByTestId("composer")).toHaveValue("Summarize the notes");
    await expect(page.locator(".attachment-shelf > span")).toContainText("notes.txt");
    expect(harness.providerCalls(),"nothing went to the provider").toBe(0);
    await shots(page,"send-attachment-gone",()=>expect(said).toBeVisible());
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
    await expect(said).toHaveText('Not sent: The attached image "shot.png" could not be read (ENOENT). Attach it again. Your draft is kept.',{timeout:20_000});
    await expect(page.getByText(/no such file or directory/)).toHaveCount(0);
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
