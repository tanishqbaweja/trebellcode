import { test,expect } from "@playwright/test";
import { openCode1App,send,shots,stopButton } from "./opencode-relay-app.js";

// An OpenCode read as a person sees it: OpenCode's read tool wraps what it read in XML tags (<path>, <type>, <content> or <entries>),
// which the read's row showed around the file's lines. This is OpenCode 1.18.32's own output for a file, recorded live. The real relay
// and OpenCode 1.x session run against a fake OpenCode 1.x server (tests/fixtures/fake-opencode1-server.mjs).
const FILE_READ="<path>H:\\work\\notes.txt</path>\n<type>file</type>\n<content>\n1: alpha line\n2: beta line\n\n(End of file - total 2 lines)\n</content>";

test("an OpenCode read's row shows the file's lines without OpenCode's XML tags",async({page})=>{
  test.setTimeout(90_000);
  let release=()=>{};const finish=new Promise(resolve=>{release=resolve});
  await openCode1App(page,async({part})=>{
    part({type:"tool",tool:"read",callID:"call_read",state:{status:"completed",input:{filePath:"H:\\work\\notes.txt"},output:FILE_READ,title:"notes.txt",metadata:{},time:{start:1,end:2}}});
    await finish;return "notes.txt has two lines.";
  },async()=>{
    await send(page,"What is in notes.txt?");
    const row=page.locator(".tool-event").filter({hasText:"Read file"});
    await expect(row).toHaveCount(1,{timeout:20_000});
    await row.locator("summary").click();
    const body=row.locator(".tool-event-body");
    await expect(body).toContainText("1: alpha line");await expect(body).toContainText("(End of file - total 2 lines)");
    await expect(body).not.toContainText("<content>");await expect(body).not.toContainText("<path>");await expect(body).not.toContainText("<type>");
    // The row's details scroll: the person scrolls to its output, the read's lines, at the end.
    const details=body.locator("pre");
    await shots(page,"opencode-read-without-tags",async()=>{await details.hover();await page.mouse.wheel(0,1200);await expect(details).toContainText("\"rawOutput\": \"1: alpha line\\n2: beta line")});
    release();
    await expect(page.locator(".assistant-message-text").filter({hasText:"notes.txt has two lines."})).toBeVisible({timeout:20_000});
    await expect(stopButton(page)).toHaveCount(0);
  });
});
