import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { replyItem,routeRelayApp,startRelayHarness } from "./relay-history-harness.js";

// What a person puts into the composer besides typed text (files, slash commands, dictation, the welcome suggestions), over a
// Trebell Native thread on the real agent relay. Attachments go to the GUI server as they do in the app.
const auditDir=fileURLToPath(new URL("../../visual-audit/composer-inputs/",import.meta.url));mkdirSync(auditDir,{recursive:true});
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

// One thread, "Composer thread", open, unless newTask leaves the window on New task. replies answers the provider's calls in order.
async function openComposerApp(page,{newTask=false,replies=[]}={}){
  const harness=await startRelayHarness({replies});
  harness.seedThread("Composer thread",[{user:"Look at the login page",items:[replyItem("seed-reply-1","The login page renders.")]}]);
  await routeRelayApp(page,harness);
  // The theme button's setting stays in the page, so later specs on the shared server keep theirs.
  await page.route(/\/api\/settings$/,route=>route.request().method()==="POST"?json(route,route.request().postDataJSON()||{}):route.fallback());
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.setViewportSize({width:1280,height:800});
  await page.goto("/");
  const row=page.locator(".thread-row").filter({has:page.locator('.thread-main[title="Composer thread"]')});
  await expect(row).toBeVisible();
  if(!newTask){
    await row.locator(".thread-main").click();
    await expect(row).toHaveClass(/active/);await expect(page.getByTestId("composer")).not.toHaveAttribute("placeholder","Opening thread…");
  }
  return harness;
}
// The header's theme button, as a person switches between dark and light, and the window at 1280x800 and 900x800 in that mode.
async function switchMode(page,mode){
  const html=page.locator("html");if(await html.getAttribute("data-mode")===mode)return;
  await page.getByTestId("appearance-toggle").first().click();await expect(html).toHaveAttribute("data-mode",mode);
}
async function shootBoth(page,name,check=async()=>{}){
  for(const mode of ["dark","light"]){
    await switchMode(page,mode);
    for(const width of [1280,900]){await page.setViewportSize({width,height:800});await check();await page.screenshot({animations:"disabled",path:auditDir+name+"-"+mode+"-"+width+"x800.png"})}
    await page.setViewportSize({width:1280,height:800});
  }
  await switchMode(page,"dark");
}
async function chooseFiles(page,files){
  const [chooser]=await Promise.all([page.waitForEvent("filechooser"),page.getByRole("button",{name:"Attach files"}).click()]);
  await chooser.setFiles(files);
}
const chips=page=>page.locator(".attachment-shelf > span");

test("a file over the attachment limit is refused at once from its size, and an accepted file shows as uploading until it is in",async({page},testInfo)=>{
  test.setTimeout(90_000);
  const harness=await openComposerApp(page);
  try{
    const uploads=[];page.on("request",request=>{if(/\/api\/attachments\/blob$/.test(request.url()))uploads.push(request.url())});
    // 51 MB is over the 50 MB the GUI server keeps: the browser knows the size before reading the file, so it is refused at once,
    // without being read or sent.
    const big=testInfo.outputPath("recording.bin");await writeFile(big,Buffer.alloc(51*1024*1024,7));
    await chooseFiles(page,big);
    const alert=page.getByTestId("app-action-error");
    await expect(alert).toHaveText("Could not attach files: Attachment is larger than 50 MB",{timeout:2000});
    await expect(chips(page)).toHaveCount(0);
    expect(uploads).toEqual([]);
    // A file within the limit shows as uploading while the server has not answered, and as attached once it has.
    let release=()=>{};const held=new Promise(resolve=>{release=resolve});
    await page.route(/\/api\/attachments\/blob$/,async route=>{await held;await route.fallback()});
    await chooseFiles(page,{name:"notes.txt",mimeType:"text/plain",buffer:Buffer.from("Release notes draft\n".repeat(4000))});
    const chip=chips(page).filter({hasText:"notes.txt"});
    await expect(chip).toHaveText(/notes\.txt\s*Uploading…/);
    await expect(chip).toHaveAttribute("aria-busy","true");
    await shootBoth(page,"attachment-uploading",()=>expect(chip).toBeInViewport());
    release();
    await expect(chip).not.toHaveAttribute("aria-busy","true");
    await expect(chip).toHaveText("notes.txt");
    await expect(chips(page)).toHaveCount(1);
    expect(uploads).toHaveLength(1);
  }finally{await harness.close()}
});
